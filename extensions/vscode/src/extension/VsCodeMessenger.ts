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
  CukiiPermissionMode,
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
import { cukiiPanelRegistry, listOpenCukiiPanels } from "../cukiiPanelRegistry";
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
import { appendSteerMessage } from "./bridgeSteer";
import { allVendorPermissionCapabilities } from "./permissionCapabilities";
import {
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
    { controller: AbortController; done: Promise<void> }
  >();

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
      run?.controller.abort();
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
    WEBVIEW_TO_CORE_PASS_THROUGH.forEach((messageType) => {
      this.onWebview(messageType, async (msg) => {
        return await this.inProcessMessenger.externalRequest(
          messageType,
          msg.data,
          msg.messageId,
        );
      });
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
      brokerPermissionMode: coerceStoredPermissionMode(
        this.context.globalState.get<CukiiPermissionMode | boolean>(
          "cukii.brokerPermissionMode",
        ),
        this.context.globalState.get<boolean>(
          "cukii.allowAllPermissions",
          false,
        ),
      ),
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
      try {
        return await startVoiceRecording(msg.data.recordingId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Cukii voice input: ${message}`);
        throw error;
      }
    });
    this.onWebview("cukii/stopVoiceRecording", async (msg) => {
      try {
        return { text: await stopVoiceRecording(msg.data.recordingId) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Cukii voice input: ${message}`);
        throw error;
      }
    });
    this.onWebview("cukii/cancelVoiceRecording", async (msg) => {
      await cancelVoiceRecording(msg.data.recordingId);
    });
    this.onWebview("cukii/voiceRecordingStatus", async (msg) =>
      voiceRecordingStatus(msg.data.recordingId),
    );
    this.onWebview("cukii/runVendorAuthAction", async (msg) => {
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
        run.controller.abort();
        await run.done;
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
      previous?.controller.abort();
      const controller = new AbortController();
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const permissionTransport: ClaudePermissionTransport = {
        panelId: this.panelIdForProtocol(protocol),
        sessionId: msg.data.sessionId,
        onRequest: async (request) => {
          protocol.send("cukii/claudePermissionRequested", request);
        },
        onBrokerCreated: (broker) => this.addPermissionBroker(protocol, broker),
        onBrokerDisposed: (broker) =>
          this.removePermissionBroker(protocol, broker),
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
      this.activeBridgeRuns.set(protocol, { controller, done });
      void done.finally(() => {
        if (this.activeBridgeRuns.get(protocol)?.controller === controller) {
          this.activeBridgeRuns.delete(protocol);
        }
      });
      return wrapped;
    });
    this.onWebview("cukii/steerDuringStream", (msg) => {
      return appendSteerMessage(msg.data.text);
    });
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
