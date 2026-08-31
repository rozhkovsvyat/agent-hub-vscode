import { ConfigHandler } from "core/config/ConfigHandler";
import { DataLogger } from "core/data/log";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import {
  FromCoreProtocol,
  FromWebviewProtocol,
  ToCoreProtocol,
} from "core/protocol";
import { ToWebviewFromCoreProtocol } from "core/protocol/coreWebview";
import { ToIdeFromWebviewOrCoreProtocol } from "core/protocol/ide";
import { ToIdeFromCoreProtocol } from "core/protocol/ideCore";
import type {
  BrokerEffort,
  BrokerModel,
  BrokerSpeed,
  BrokerSubagent,
  BrokerVendorAuthAction,
  BrokerVendorId,
  CukiiCancelReceipt,
  CukiiPermissionMode,
  CukiiSteerReceipt,
} from "core/protocol/ideWebview";
import { coerceStoredPermissionMode } from "core/cukiiPermissionModes";
import { InProcessMessenger, Message } from "core/protocol/messenger";
import {
  CORE_TO_WEBVIEW_PASS_THROUGH,
  WEBVIEW_TO_CORE_PASS_THROUGH,
} from "core/protocol/passThrough";
import { stripImages } from "core/util/messageContent";
import * as vscode from "vscode";

import { ApplyManager } from "../apply";
import {
  cukiiPanelRegistry,
  listOpenCukiiPanels,
  syncCukiiPanelTitleForSession,
} from "../cukiiPanelRegistry";
import { VerticalDiffManager } from "../diff/vertical/manager";
import { addCurrentSelectionToEdit } from "../quickEdit/AddCurrentSelection";
import EditDecorationManager from "../quickEdit/EditDecorationManager";
import { handleLLMError } from "../util/errorHandling";
import { showTutorial } from "../util/tutorial";
import { getExtensionUri } from "../util/vscode";
import { VsCodeIde } from "../VsCodeIde";
import { VsCodeWebviewProtocol } from "../webviewProtocol";

import { VsCodeExtension } from "./VsCodeExtension";
import {
  isClaudeNativeModel,
  streamBridgeChat,
  type ClaudePermissionTransport,
} from "./bridgeChatAdapter";
import type { ClaudePermissionBroker } from "./claudePermissionBroker";
import { listBrokerModelCatalog } from "./bridgeModelCatalog";
import {
  cancelVoiceRecording,
  startVoiceRecording,
  stopVoiceRecording,
  voiceRecordingStatus,
} from "./voiceDictation";
import { BridgeSteeringController } from "./bridgeSteer";
import { BridgeRunCancellation } from "./bridgeRunCancellation";
import { allVendorPermissionCapabilities } from "./permissionCapabilities";
import {
  clearBrokerVendorAccountCache,
  listBrokerVendorAccounts,
  vendorAuthTerminalCommand,
} from "./bridgeVendorAuth";
import { isRealPanelSessionTransition } from "./panelSessionTransition";

type ToIdeOrWebviewFromCoreProtocol = ToIdeFromCoreProtocol &
  ToWebviewFromCoreProtocol;

function sourceProtocol(
  message: Message,
  fallback: VsCodeWebviewProtocol,
): VsCodeWebviewProtocol {
  return (
    (message as Message & { __cukiiWebviewProtocol?: VsCodeWebviewProtocol })
      .__cukiiWebviewProtocol ?? fallback
  );
}

type ActiveBridgeRun = {
  controller: AbortController;
  done: Promise<void>;
  sessionId: string;
  steering: BridgeSteeringController;
  cancellation: BridgeRunCancellation;
};

/**
 * A shared messenger class between Core and Webview
 * so we don't have to rewrite some of the handlers
 */
export class VsCodeMessenger {
  /** Brokers are scoped to the exact webview protocol that created the run. */
  private readonly claudePermissionBrokers = new Map<
    VsCodeWebviewProtocol,
    Set<ClaudePermissionBroker>
  >();
  private readonly panelSessionIds = new Map<VsCodeWebviewProtocol, string>();
  private readonly activeBridgeRuns = new Map<
    VsCodeWebviewProtocol,
    ActiveBridgeRun
  >();

  private async cancelBridgeRun(
    run: ActiveBridgeRun,
    requestId: string,
  ): Promise<CukiiCancelReceipt> {
    const { alreadyCancelled, receipt } = run.cancellation.cancel();
    const result = await receipt;
    return {
      requestId,
      sessionId: run.sessionId,
      status: alreadyCancelled ? "already-cancelled" : "cancelled",
      interrupted: result.interrupted,
    };
  }

  private panelIdForProtocol(protocol: VsCodeWebviewProtocol): string {
    return (
      cukiiPanelRegistry
        .values()
        .find((entry) => entry.panel.protocol === protocol)?.id ?? "sidebar"
    );
  }

  private addPermissionBroker(
    protocol: VsCodeWebviewProtocol,
    broker: ClaudePermissionBroker,
  ): void {
    const brokers = this.claudePermissionBrokers.get(protocol) ?? new Set();
    brokers.add(broker);
    this.claudePermissionBrokers.set(protocol, brokers);
  }

  private removePermissionBroker(
    protocol: VsCodeWebviewProtocol,
    broker: ClaudePermissionBroker,
  ): void {
    const brokers = this.claudePermissionBrokers.get(protocol);
    if (!brokers) return;
    brokers.delete(broker);
    if (brokers.size === 0) this.claudePermissionBrokers.delete(protocol);
  }

  onWebview<T extends keyof FromWebviewProtocol>(
    messageType: T,
    handler: (
      message: Message<FromWebviewProtocol[T][0]>,
    ) => Promise<FromWebviewProtocol[T][1]> | FromWebviewProtocol[T][1],
  ): void {
    void this.webviewProtocol.on(messageType, handler);
  }

  onCore<T extends keyof ToIdeOrWebviewFromCoreProtocol>(
    messageType: T,
    handler: (
      message: Message<ToIdeOrWebviewFromCoreProtocol[T][0]>,
    ) =>
      | Promise<ToIdeOrWebviewFromCoreProtocol[T][1]>
      | ToIdeOrWebviewFromCoreProtocol[T][1],
  ): void {
    this.inProcessMessenger.externalOn(messageType, handler);
  }

  onWebviewOrCore<T extends keyof ToIdeFromWebviewOrCoreProtocol>(
    messageType: T,
    handler: (
      message: Message<ToIdeFromWebviewOrCoreProtocol[T][0]>,
    ) =>
      | Promise<ToIdeFromWebviewOrCoreProtocol[T][1]>
      | ToIdeFromWebviewOrCoreProtocol[T][1],
  ): void {
    this.onWebview(messageType, handler);
    this.onCore(messageType, handler);
  }

  constructor(
    private readonly inProcessMessenger: InProcessMessenger<
      ToCoreProtocol,
      FromCoreProtocol
    >,
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly ide: VsCodeIde,
    private readonly verticalDiffManagerPromise: Promise<VerticalDiffManager>,
    private readonly configHandlerPromise: Promise<ConfigHandler>,
    private readonly editDecorationManager: EditDecorationManager,
    private readonly context: vscode.ExtensionContext,
    private readonly vsCodeExtension: VsCodeExtension,
  ) {
    this.webviewProtocol.onDispose((protocol) => {
      const run = this.activeBridgeRuns.get(protocol);
      if (run) void this.cancelBridgeRun(run, `dispose:${run.sessionId}`);
      const brokers = [...(this.claudePermissionBrokers.get(protocol) ?? [])];
      for (const broker of brokers) broker.denyAll();
      void Promise.all(brokers.map((broker) => broker.dispose())).finally(
        () => {
          this.claudePermissionBrokers.delete(protocol);
          this.activeBridgeRuns.delete(protocol);
          this.panelSessionIds.delete(protocol);
        },
      );
    });
    /** WEBVIEW ONLY LISTENERS **/
    this.onWebview("showFile", (msg) => {
      this.ide.openFile(msg.data.filepath);
    });

    this.onWebview("vscode/openMoveRightMarkdown", (msg) => {
      vscode.commands.executeCommand(
        "markdown.showPreview",
        vscode.Uri.joinPath(
          getExtensionUri(),
          "media",
          "move-chat-panel-right.md",
        ),
      );
    });

    this.onWebview("toggleDevTools", (msg) => {
      vscode.commands.executeCommand("continue.viewLogs");
    });

    this.onWebview("reloadWindow", (msg) => {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
    this.onWebview("focusEditor", (msg) => {
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    });
    this.onWebview("cukii/getActiveEditorSelectionState", () => {
      const editor = vscode.window.activeTextEditor;
      return { hasSelection: !!editor && !editor.selection.isEmpty };
    });
    this.onWebview("toggleFullScreen", (msg) => {
      vscode.commands.executeCommand("continue.openInNewWindow");
    });

    this.onWebview("cukii/openChatPanel", async ({ data }) => {
      await vscode.commands.executeCommand("continue.openInNewWindow", data);
    });

    this.onWebview("cukii/listOpenChatPanels", () => listOpenCukiiPanels());

    this.onWebview("cukii/renameSession", async ({ data }) => {
      const trimmed = data.title.trim();
      if (!trimmed) {
        return { ok: false };
      }
      const saved = await this.inProcessMessenger.externalRequest(
        "history/rename",
        { id: data.sessionId, title: trimmed },
      );
      if (!saved) return { ok: false };
      // The persistence boundary may have retained a concurrent manual title.
      // Reflect the effective value, never the stale requested value.
      const effectiveTitle = saved.title;
      syncCukiiPanelTitleForSession(data.sessionId, effectiveTitle);
      const titlePayload = {
        sessionId: data.sessionId,
        title: effectiveTitle,
        titleManuallySet: Boolean(saved.titleManuallySet),
      };
      for (const entry of cukiiPanelRegistry.values()) {
        entry.panel.protocol.send("cukii/sessionTitleChanged", titlePayload);
      }
      this.webviewProtocol.send("cukii/sessionTitleChanged", titlePayload);
      this.webviewProtocol.send(
        "cukii/openChatPanelsChanged",
        listOpenCukiiPanels(),
      );
      return {
        ok: true,
        title: effectiveTitle,
        titleManuallySet: Boolean(saved.titleManuallySet),
      };
    });

    this.onWebview("acceptDiff", async ({ data: { filepath, streamId } }) => {
      await vscode.commands.executeCommand(
        "continue.acceptDiff",
        filepath,
        streamId,
      );
    });

    this.onWebview("rejectDiff", async ({ data: { filepath, streamId } }) => {
      await vscode.commands.executeCommand(
        "continue.rejectDiff",
        filepath,
        streamId,
      );
    });

    this.onWebview("applyToFile", async (message) => {
      const { data } = message;
      const [verticalDiffManager, configHandler] = await Promise.all([
        verticalDiffManagerPromise,
        configHandlerPromise,
      ]);

      const applyManager = new ApplyManager(
        this.ide,
        sourceProtocol(message, webviewProtocol),
        verticalDiffManager,
        configHandler,
      );

      await applyManager.applyToFile(data);
    });

    this.onWebview("showTutorial", async (msg) => {
      await showTutorial(this.ide);
    });

    this.onWebview(
      "overwriteFile",
      async ({ data: { prevFileContent, filepath } }) => {
        if (prevFileContent === null) {
          // TODO: Delete the file
          return;
        }

        await this.ide.openFile(filepath);

        // Get active text editor
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
          vscode.window.showErrorMessage("No active editor to apply edits to");
          return;
        }

        editor.edit((builder) =>
          builder.replace(
            new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length),
            ),
            prevFileContent,
          ),
        );
      },
    );

    this.onWebview("insertAtCursor", async (msg) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || !editor.selection) {
        return;
      }

      editor.edit((editBuilder) => {
        editBuilder.replace(
          new vscode.Range(editor.selection.start, editor.selection.end),
          msg.data.text,
        );
      });
    });
    this.onWebview("edit/addCurrentSelection", async (msg) => {
      const verticalDiffManager = await this.verticalDiffManagerPromise;
      await addCurrentSelectionToEdit({
        args: undefined,
        editDecorationManager,
        webviewProtocol: sourceProtocol(msg, this.webviewProtocol),
        verticalDiffManager,
      });
    });
    this.onWebview("edit/sendPrompt", async (msg) => {
      const prompt = msg.data.prompt;
      const { start, end } = msg.data.range.range;
      const verticalDiffManager = await verticalDiffManagerPromise;

      const configHandler = await configHandlerPromise;
      const { config } = await configHandler.loadConfig();

      if (!config) {
        throw new Error("Edit: Failed to load config");
      }

      const model =
        config?.selectedModelByRole.edit ?? config?.selectedModelByRole.chat;

      if (!model) {
        throw new Error("No Edit or Chat model selected");
      }

      const fileAfterEdit = await verticalDiffManager.streamEdit({
        input: stripImages(prompt),
        llm: model,
        streamId: EDIT_MODE_STREAM_ID,
        range: new vscode.Range(
          new vscode.Position(start.line, start.character),
          new vscode.Position(end.line, end.character),
        ),
        rulesToInclude: config.rules,
        isApply: false,
      });

      // Log dev data
      await DataLogger.getInstance().logDevData({
        name: "editInteraction",
        data: {
          prompt: stripImages(prompt),
          completion: fileAfterEdit ?? "",
          modelProvider: model.underlyingProviderName,
          modelName: model.title ?? "",
          modelTitle: model.title ?? "",
          filepath: msg.data.range.filepath,
        },
      });

      return fileAfterEdit;
    });

    this.onWebview("edit/clearDecorations", async (msg) => {
      editDecorationManager.clear();
    });

    this.onWebview("session/share", async (msg) => {
      await vscode.commands.executeCommand(
        "continue.shareSession",
        msg.data.sessionId,
      );
    });

    /** PASS THROUGH FROM WEBVIEW TO CORE AND BACK **/
    WEBVIEW_TO_CORE_PASS_THROUGH.filter(
      (messageType) => messageType !== "history/save",
    ).forEach((messageType) => {
      this.onWebview(messageType, async (msg) => {
        return await this.inProcessMessenger.externalRequest(
          messageType,
          msg.data,
          msg.messageId,
        );
      });
    });

    this.onWebview("history/save", async (msg) => {
      const result = await this.inProcessMessenger.externalRequest(
        "history/save",
        msg.data,
        msg.messageId,
      );
      // HistoryManager.save is the sole CAS/merge boundary and returns the
      // effective session, including a manual title or newer history that a
      // stale auto-title request was not allowed to overwrite.
      const session = result;
      if (session.sessionId && session.title) {
        syncCukiiPanelTitleForSession(session.sessionId, session.title);
        this.webviewProtocol.send(
          "cukii/openChatPanelsChanged",
          listOpenCukiiPanels(),
        );
      }
      return result;
    });

    /** PASS THROUGH FROM CORE TO WEBVIEW AND BACK **/
    CORE_TO_WEBVIEW_PASS_THROUGH.forEach((messageType) => {
      this.onCore(messageType, async (msg) => {
        const target = cukiiPanelRegistry.lastActive()?.panel.protocol;
        if (!target) {
          return undefined as any;
        }
        return target.request(messageType, msg.data);
      });
    });

    /** CORE ONLY LISTENERS **/
    // None right now

    /** BOTH CORE AND WEBVIEW **/
    this.onWebviewOrCore("readRangeInFile", async (msg) => {
      return await vscode.workspace
        .openTextDocument(msg.data.filepath)
        .then((document) => {
          const start = new vscode.Position(0, 0);
          const end = new vscode.Position(5, 0);
          const range = new vscode.Range(start, end);

          const contents = document.getText(range);
          return contents;
        });
    });

    this.onWebviewOrCore("getIdeSettings", async (msg) => {
      return ide.getIdeSettings();
    });
    this.onWebviewOrCore("getDiff", async (msg) => {
      return ide.getDiff(msg.data.includeUnstaged);
    });
    this.onWebviewOrCore("getTerminalContents", async (msg) => {
      return ide.getTerminalContents();
    });
    this.onWebviewOrCore("getDebugLocals", async (msg) => {
      return ide.getDebugLocals(Number(msg.data.threadIndex));
    });
    this.onWebviewOrCore("getAvailableThreads", async (msg) => {
      return ide.getAvailableThreads();
    });
    this.onWebviewOrCore("getTopLevelCallStackSources", async (msg) => {
      return ide.getTopLevelCallStackSources(
        msg.data.threadIndex,
        msg.data.stackDepth,
      );
    });
    this.onWebviewOrCore("getWorkspaceDirs", async (msg) => {
      return ide.getWorkspaceDirs();
    });
    this.onWebviewOrCore("writeFile", async (msg) => {
      return ide.writeFile(msg.data.path, msg.data.contents);
    });
    this.onWebviewOrCore("showVirtualFile", async (msg) => {
      return ide.showVirtualFile(msg.data.name, msg.data.content);
    });
    this.onWebviewOrCore("openFile", async (msg) => {
      return ide.openFile(msg.data.path);
    });
    this.onWebviewOrCore("runCommand", async (msg) => {
      await ide.runCommand(msg.data.command);
    });
    this.onWebview("cukii/openBridgeSession", async (msg) => {
      await vscode.commands.executeCommand(
        "cukii.openBridgeSession",
        msg.data.agent,
      );
    });
    this.onWebview("cukii/getBrokerPreferences", () => ({
      brokerModel: this.context.globalState.get<BrokerModel>(
        "cukii.brokerModel",
        "opus-5",
      ),
      brokerSubagent: this.context.globalState.get<BrokerSubagent>(
        "cukii.brokerSubagent",
        "auto",
      ),
      brokerEffort: this.context.globalState.get<BrokerEffort>(
        "cukii.brokerEffort",
        "high",
      ),
      brokerSpeed: this.context.globalState.get<BrokerSpeed>(
        "cukii.brokerSpeed",
        "standard",
      ),
      thinkingEnabled: this.context.globalState.get<boolean>(
        "cukii.thinkingEnabled",
        true,
      ),
      brokerPermissionMode: (() => {
        const stored = this.context.globalState.get<
          CukiiPermissionMode | boolean
        >("cukii.brokerPermissionMode");
        return stored === undefined
          ? "bypass"
          : coerceStoredPermissionMode(
              stored,
              this.context.globalState.get<boolean>(
                "cukii.allowAllPermissions",
                false,
              ),
            );
      })(),
      mode: this.context.globalState.get<"chat" | "plan" | "agent" | "broker">(
        "cukii.brokerMode",
        "broker",
      ),
    }));
    this.onWebview("cukii/setBrokerPreferences", async (msg) => {
      await Promise.all([
        this.context.globalState.update(
          "cukii.brokerModel",
          msg.data.brokerModel,
        ),
        this.context.globalState.update(
          "cukii.brokerSubagent",
          msg.data.brokerSubagent,
        ),
        this.context.globalState.update(
          "cukii.brokerEffort",
          msg.data.brokerEffort,
        ),
        this.context.globalState.update(
          "cukii.brokerSpeed",
          msg.data.brokerSpeed,
        ),
        this.context.globalState.update(
          "cukii.thinkingEnabled",
          msg.data.thinkingEnabled,
        ),
        ...(msg.data.brokerPermissionMode
          ? [
              this.context.globalState.update(
                "cukii.brokerPermissionMode",
                msg.data.brokerPermissionMode,
              ),
              this.context.globalState.update(
                "cukii.allowAllPermissions",
                msg.data.brokerPermissionMode === "bypass",
              ),
            ]
          : []),
        ...(msg.data.mode
          ? [this.context.globalState.update("cukii.brokerMode", msg.data.mode)]
          : []),
      ]);
    });
    this.onWebview("cukii/listPermissionCapabilities", async () => {
      const capabilities = await allVendorPermissionCapabilities();
      return Object.values(capabilities).map(
        ({ vendor, supportedModes, cliVersion }) => ({
          vendor,
          supportedModes,
          cliVersion,
        }),
      );
    });
    this.onWebview("cukii/listVendorAccounts", async () => {
      return listBrokerVendorAccounts();
    });
    this.onWebview("cukii/listBrokerModelCatalog", async () => {
      return listBrokerModelCatalog();
    });
    this.onWebview("cukii/pickAttachmentFiles", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: "Upload",
        title: "Upload files to Cukii",
      });
      return (picked ?? []).map((uri) => ({
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).at(-1) ?? uri.fsPath,
      }));
    });
    this.onWebview("cukii/startVoiceRecording", async (msg) => {
      return await startVoiceRecording(msg.data.recordingId);
    });
    this.onWebview("cukii/stopVoiceRecording", async (msg) => {
      return { text: await stopVoiceRecording(msg.data.recordingId) };
    });
    this.onWebview("cukii/cancelVoiceRecording", async (msg) => {
      await cancelVoiceRecording(msg.data.recordingId);
    });
    this.onWebview("cukii/voiceRecordingStatus", async (msg) =>
      voiceRecordingStatus(msg.data.recordingId),
    );
    this.onWebview("cukii/runVendorAuthAction", async (msg) => {
      clearBrokerVendorAccountCache();
      const spec = vendorAuthTerminalCommand(
        msg.data.vendor as BrokerVendorId,
        msg.data.action as BrokerVendorAuthAction,
      );
      if (!spec) {
        return {
          opened: false,
          message:
            "This vendor does not expose that CLI authentication action.",
        };
      }
      const terminal = vscode.window.createTerminal({ name: spec.name });
      terminal.show();
      terminal.sendText(spec.command, true);
      if (spec.followup) {
        setTimeout(() => terminal.sendText(spec.followup!, true), 1_500);
      }
      return {
        opened: true,
        message:
          msg.data.action === "install"
            ? "Latest CLI installation opened in the integrated terminal."
            : "Authentication flow opened in the integrated terminal.",
      };
    });
    this.onWebview("cukii/respondClaudePermission", (msg) => {
      const protocol = sourceProtocol(msg, this.webviewProtocol);
      const accepted = [
        ...(this.claudePermissionBrokers.get(protocol) ?? []),
      ].some((broker) => broker.respond(msg.data));
      // A forged or stale response must be silent and fail closed. In
      // particular, never relay it to a different panel's pending request.
      if (!accepted) return;
    });
    const disposePermissionBrokersFor = async (
      protocol: VsCodeWebviewProtocol,
    ) => {
      const run = this.activeBridgeRuns.get(protocol);
      if (run) {
        await this.cancelBridgeRun(run, `abort:${run.sessionId}`);
      }
      const brokers = [...(this.claudePermissionBrokers.get(protocol) ?? [])];
      for (const broker of brokers) {
        // Stop/session replacement is an authority boundary: do not leave an
        // MCP worker waiting behind a closed chat or retain its private config.
        await broker.dispose();
        this.removePermissionBroker(protocol, broker);
      }
    };
    this.onWebview("abort", async (msg) => {
      await disposePermissionBrokersFor(
        sourceProtocol(msg, this.webviewProtocol),
      );
    });
    this.onWebview("cukii/panelSessionChanged", async (msg) => {
      const protocol = sourceProtocol(msg, this.webviewProtocol);
      const previous = this.panelSessionIds.get(protocol);
      this.panelSessionIds.set(protocol, msg.data.sessionId);
      if (isRealPanelSessionTransition(previous, msg.data.sessionId)) {
        await disposePermissionBrokersFor(protocol);
      }
    });
    this.onWebview("cukii/streamBridgeChat", (msg) => {
      const protocol = sourceProtocol(msg, this.webviewProtocol);
      const previous = this.activeBridgeRuns.get(protocol);
      if (previous) {
        void this.cancelBridgeRun(previous, `replace:${previous.sessionId}`);
      }
      const controller = new AbortController();
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const steering = new BridgeSteeringController(
        msg.data.sessionId,
        isClaudeNativeModel(msg.data.brokerModel),
      );
      const cancellation = new BridgeRunCancellation(
        () => controller.abort(),
        done,
      );
      const run = {
        controller,
        done,
        sessionId: msg.data.sessionId,
        steering,
        cancellation,
      };
      const permissionTransport: ClaudePermissionTransport = {
        panelId: this.panelIdForProtocol(protocol),
        sessionId: msg.data.sessionId,
        onRequest: async (request) => {
          protocol.send("cukii/claudePermissionRequested", request);
        },
        onBrokerCreated: (broker) => this.addPermissionBroker(protocol, broker),
        onBrokerDisposed: (broker) =>
          this.removePermissionBroker(protocol, broker),
        steering,
        onToolActivity: (event) => {
          if (event.kind === "start") cancellation.toolStarted(event.id);
          else cancellation.toolFinished(event.id);
        },
        // This is deliberately sent over the active extension/webview channel.
        // The local canary controller watches this iframe over CDP; a Remote-SSH
        // user-writable JSONL file is never accepted as runtime evidence.
        onRuntimeCanaryEvent: (event) => {
          protocol.send("cukii/runtimeCanaryAttestation", event);
        },
        abortSignal: controller.signal,
      };
      const stream = streamBridgeChat(msg.data, permissionTransport);
      const wrapped = (async function* () {
        if (previous) await previous.done;
        try {
          return yield* stream;
        } finally {
          resolveDone();
        }
      })();
      this.activeBridgeRuns.set(protocol, run);
      void done.finally(() => {
        steering.close();
        if (this.activeBridgeRuns.get(protocol)?.controller === controller) {
          this.activeBridgeRuns.delete(protocol);
        }
      });
      return wrapped;
    });
    this.onWebview(
      "cukii/steerDuringStream",
      async (msg): Promise<CukiiSteerReceipt> => {
        const protocol = sourceProtocol(msg, this.webviewProtocol);
        const run = this.activeBridgeRuns.get(protocol);
        if (!run || run.sessionId !== msg.data.sessionId) {
          return {
            messageId: msg.data.messageId,
            sessionId: msg.data.sessionId,
            status: "deferred",
          };
        }
        return run.steering.deliver(msg.data);
      },
    );
    this.onWebview(
      "cukii/cancelBridgeRun",
      async (msg): Promise<CukiiCancelReceipt> => {
        const protocol = sourceProtocol(msg, this.webviewProtocol);
        const run = this.activeBridgeRuns.get(protocol);
        if (!run || run.sessionId !== msg.data.sessionId) {
          return {
            requestId: msg.data.requestId,
            sessionId: msg.data.sessionId,
            status: "already-cancelled",
            interrupted: "turn",
          };
        }
        return this.cancelBridgeRun(run, msg.data.requestId);
      },
    );
    this.onWebviewOrCore("getSearchResults", async (msg) => {
      return ide.getSearchResults(msg.data.query, msg.data.maxResults);
    });
    this.onWebviewOrCore("getFileResults", async (msg) => {
      return ide.getFileResults(msg.data.pattern, msg.data.maxResults);
    });
    this.onWebviewOrCore("subprocess", async (msg) => {
      return ide.subprocess(msg.data.command, msg.data.cwd);
    });
    this.onWebviewOrCore("getProblems", async (msg) => {
      return ide.getProblems(msg.data.filepath);
    });
    this.onWebviewOrCore("getBranch", async (msg) => {
      const { dir } = msg.data;
      return ide.getBranch(dir);
    });
    this.onWebviewOrCore("getOpenFiles", async (msg) => {
      return ide.getOpenFiles();
    });
    this.onWebviewOrCore("getCurrentFile", async () => {
      return ide.getCurrentFile();
    });
    this.onWebviewOrCore("getPinnedFiles", async (msg) => {
      return ide.getPinnedFiles();
    });
    this.onWebviewOrCore("showLines", async (msg) => {
      const { filepath, startLine, endLine } = msg.data;
      return ide.showLines(filepath, startLine, endLine);
    });
    this.onWebviewOrCore("showToast", (msg) => {
      this.ide.showToast(...msg.data);
    });
    this.onWebviewOrCore("saveFile", async (msg) => {
      return await ide.saveFile(msg.data.filepath);
    });
    this.onWebviewOrCore("readFile", async (msg) => {
      return await ide.readFile(msg.data.filepath);
    });
    this.onWebviewOrCore("openUrl", (msg) => {
      vscode.env.openExternal(vscode.Uri.parse(msg.data));
    });

    this.onWebviewOrCore("fileExists", async (msg) => {
      return await ide.fileExists(msg.data.filepath);
    });

    this.onWebviewOrCore("gotoDefinition", async (msg) => {
      return await ide.gotoDefinition(msg.data.location);
    });

    this.onWebviewOrCore("getReferences", async (msg) => {
      return await ide.getReferences(msg.data.location);
    });

    this.onWebviewOrCore("getDocumentSymbols", async (msg) => {
      return await ide.getDocumentSymbols(msg.data.textDocumentIdentifier);
    });

    this.onWebviewOrCore("getFileStats", async (msg) => {
      return await ide.getFileStats(msg.data.files);
    });

    this.onWebviewOrCore("getGitRootPath", async (msg) => {
      return await ide.getGitRootPath(msg.data.dir);
    });

    this.onWebviewOrCore("listDir", async (msg) => {
      return await ide.listDir(msg.data.dir);
    });

    this.onWebviewOrCore("getRepoName", async (msg) => {
      return await ide.getRepoName(msg.data.dir);
    });

    this.onWebviewOrCore("getTags", async (msg) => {
      return await ide.getTags(msg.data);
    });

    this.onWebviewOrCore("getIdeInfo", async (msg) => {
      return await ide.getIdeInfo();
    });

    this.onWebviewOrCore("isTelemetryEnabled", async (msg) => {
      return await ide.isTelemetryEnabled();
    });

    this.onWebviewOrCore("getUniqueId", async (msg) => {
      return await ide.getUniqueId();
    });

    this.onWebviewOrCore("reportError", async (msg) => {
      await handleLLMError(msg.data);
    });
  }
}
