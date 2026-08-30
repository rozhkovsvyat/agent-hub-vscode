import fs from "fs";
import path from "path";

import { IContextProvider } from "core";
import { ConfigHandler } from "core/config/ConfigHandler";
import { EXTENSION_NAME } from "core/util/constants";
import { Core } from "core/core";
import { FromCoreProtocol, ToCoreProtocol } from "core/protocol";
import { InProcessMessenger } from "core/protocol/messenger";
import {
  getConfigJsonPath,
  getConfigTsPath,
  getConfigYamlPath,
  getContinueGlobalPath,
} from "core/util/paths";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";

import { ContinueCompletionProvider } from "../autocomplete/completionProvider";
import {
  monitorBatteryChanges,
  setupStatusBar,
  StatusBarStatus,
} from "../autocomplete/statusBar";
import { registerAllCommands } from "../commands";
import { ContinueConsoleWebviewViewProvider } from "../ContinueConsoleWebviewViewProvider";
import { ContinueGUIWebviewViewProvider } from "../ContinueGUIWebviewViewProvider";
import { cukiiPanelRegistry } from "../cukiiPanelRegistry";
import { VerticalDiffManager } from "../diff/vertical/manager";
import { registerAllCodeLensProviders } from "../lang-server/codeLens";
import { registerAllPromptFilesCompletionProviders } from "../lang-server/promptFileCompletions";
import EditDecorationManager from "../quickEdit/EditDecorationManager";
import { QuickEdit } from "../quickEdit/QuickEditQuickPick";
import { UriEventHandler } from "../stubs/uriHandler";
import { Battery } from "../util/battery";
import { FileSearch } from "../util/FileSearch";
import { VsCodeIdeUtils } from "../util/ideUtils";
import { VsCodeIde } from "../VsCodeIde";

import { ConfigYamlDocumentLinkProvider } from "./ConfigYamlDocumentLinkProvider";
import { VsCodeMessenger } from "./VsCodeMessenger";
import {
  listBridgeScopes,
  listBrokerSessions,
  delegateBridgeWorker,
  openBridgeSession,
  recoverBridgeSession,
} from "./bridgeUiClient";
import { bridgeTerminalLaunchSpec } from "./bridgeTerminalCommand";

import { modelSupportsNextEdit } from "core/llm/autodetect";
import { NEXT_EDIT_MODELS } from "core/llm/constants";
import { NextEditProvider } from "core/nextEdit/NextEditProvider";
import { isNextEditTest } from "core/nextEdit/utils";
import { JumpManager } from "../activation/JumpManager";
import setupNextEditWindowManager, {
  NextEditWindowManager,
} from "../activation/NextEditWindowManager";
import {
  HandlerPriority,
  SelectionChangeManager,
} from "../activation/SelectionChangeManager";
import { GhostTextAcceptanceTracker } from "../autocomplete/GhostTextAcceptanceTracker";
import { getDefinitionsFromLsp } from "../autocomplete/lsp";
import {
  clearDocumentContentCache,
  handleTextDocumentChange,
  initDocumentContentCache,
} from "../util/editLoggingUtils";
import type { VsCodeWebviewProtocol } from "../webviewProtocol";

export class VsCodeExtension {
  // Currently some of these are public so they can be used in testing (test/test-suites)

  private configHandler: ConfigHandler;
  private extensionContext: vscode.ExtensionContext;
  private ide: VsCodeIde;
  private ideUtils: VsCodeIdeUtils;
  private consoleView: ContinueConsoleWebviewViewProvider;
  private sidebar: ContinueGUIWebviewViewProvider;
  private windowId: string;
  private editDecorationManager: EditDecorationManager;
  private verticalDiffManager: VerticalDiffManager;
  webviewProtocolPromise: Promise<VsCodeWebviewProtocol>;
  private core: Core;
  private battery: Battery;
  private fileSearch: FileSearch;
  private uriHandler = new UriEventHandler();
  private completionProvider: ContinueCompletionProvider;

  private broadcastActiveEditorSelection(): void {
    const editor = vscode.window.activeTextEditor;
    const data = {
      hasSelection: !!editor && !editor.selection.isEmpty,
    };
    this.sidebar.webviewProtocol.send(
      "cukii/activeEditorSelectionChanged",
      data,
    );
    for (const entry of cukiiPanelRegistry.values()) {
      entry.panel.protocol.send("cukii/activeEditorSelectionChanged", data);
    }
  }

  public async shutdown(): Promise<void> {
    await this.core.shutdown();
  }

  private ARBITRARY_TYPING_DELAY = 2000;

  /**
   * This is how you turn next edit on or off at the extension level.
   * This is called on config reload and autocomplete menu updates.
   * This is also the place you want to check to enable/disable next edit during e2e tests,
   * because it tends to stain other e2e tests and make them fail.
   */
  private async updateNextEditState(
    context: vscode.ExtensionContext,
  ): Promise<void> {
    const { config: continueConfig } = await this.configHandler.loadConfig();
    const autocompleteModel = continueConfig?.selectedModelByRole.autocomplete;
    const vscodeConfig = vscode.workspace.getConfiguration(EXTENSION_NAME);

    const modelSupportsNext =
      autocompleteModel &&
      modelSupportsNextEdit(
        autocompleteModel.capabilities,
        autocompleteModel.model,
        autocompleteModel.title,
      );

    // Use smart defaults.
    let nextEditEnabled = vscodeConfig.get<boolean>("enableNextEdit");
    if (nextEditEnabled === undefined) {
      // First time - set smart default.
      nextEditEnabled = modelSupportsNext ?? false;
      await vscodeConfig.update(
        "enableNextEdit",
        nextEditEnabled,
        vscode.ConfigurationTarget.Global,
      );
    }

    // Check if Next Edit is enabled but model doesn't support it.
    if (
      nextEditEnabled &&
      !modelSupportsNext &&
      !isNextEditTest() &&
      process.env.CONTINUE_E2E_NON_NEXT_EDIT_TEST === "true"
    ) {
      vscode.window
        .showWarningMessage(
          `The current autocomplete model (${autocompleteModel?.title || "unknown"}) does not support Next Edit.`,
          "Disable Next Edit",
          "Select different model",
        )
        .then((selection) => {
          if (selection === "Disable Next Edit") {
            vscodeConfig.update(
              "enableNextEdit",
              false,
              vscode.ConfigurationTarget.Global,
            );
          } else if (selection === "Select different model") {
            vscode.commands.executeCommand(
              "continue.openTabAutocompleteConfigMenu",
            );
          }
        });
    }

    const shouldEnableNextEdit =
      (modelSupportsNext && nextEditEnabled) || isNextEditTest();

    if (shouldEnableNextEdit) {
      await setupNextEditWindowManager(context);
      this.activateNextEdit();
      await NextEditWindowManager.freeTabAndEsc();

      const jumpManager = JumpManager.getInstance();
      jumpManager.registerSelectionChangeHandler();

      const ghostTextAcceptanceTracker =
        GhostTextAcceptanceTracker.getInstance();
      ghostTextAcceptanceTracker.registerSelectionChangeHandler();

      const nextEditWindowManager = NextEditWindowManager.getInstance();
      nextEditWindowManager.registerSelectionChangeHandler();
    } else {
      NextEditWindowManager.clearInstance();
      this.deactivateNextEdit();
      await NextEditWindowManager.freeTabAndEsc();

      JumpManager.clearInstance();
      GhostTextAcceptanceTracker.clearInstance();
    }
  }

  constructor(context: vscode.ExtensionContext) {
    this.editDecorationManager = new EditDecorationManager(context);

    let resolveWebviewProtocol: any = undefined;
    this.webviewProtocolPromise = new Promise<VsCodeWebviewProtocol>(
      (resolve) => {
        resolveWebviewProtocol = resolve;
      },
    );
    this.ide = new VsCodeIde(this.webviewProtocolPromise, context);
    this.ideUtils = new VsCodeIdeUtils();
    this.extensionContext = context;
    this.windowId = uuidv4();

    // Check if model supports next edit to determine if we should use full file diff.
    const getUsingFullFileDiff = async () => {
      const { config } = await this.configHandler.loadConfig();
      const autocompleteModel = config?.selectedModelByRole.autocomplete;

      if (!autocompleteModel) {
        return false;
      }

      if (
        !modelSupportsNextEdit(
          autocompleteModel.capabilities,
          autocompleteModel.model,
          autocompleteModel.title,
        )
      ) {
        return false;
      }

      if (autocompleteModel.model.includes(NEXT_EDIT_MODELS.INSTINCT)) {
        return false;
      }

      return true;
    };

    const usingFullFileDiff = true;
    const selectionManager = SelectionChangeManager.getInstance();
    selectionManager.initialize(this.ide, usingFullFileDiff);

    selectionManager.registerListener(
      "typing",
      async (e, state) => {
        const timeSinceLastDocChange =
          Date.now() - state.lastDocumentChangeTime;
        if (
          state.isTypingSession &&
          timeSinceLastDocChange < this.ARBITRARY_TYPING_DELAY &&
          !NextEditWindowManager.getInstance().hasAccepted()
        ) {
          // console.debug(
          //   "VsCodeExtension: typing in progress, preserving chain",
          // );
          return true;
        }

        return false;
      },
      HandlerPriority.NORMAL,
    );

    // Dependencies of core
    let resolveVerticalDiffManager: any = undefined;
    const verticalDiffManagerPromise = new Promise<VerticalDiffManager>(
      (resolve) => {
        resolveVerticalDiffManager = resolve;
      },
    );
    let resolveConfigHandler: any = undefined;
    const configHandlerPromise = new Promise<ConfigHandler>((resolve) => {
      resolveConfigHandler = resolve;
    });
    this.sidebar = new ContinueGUIWebviewViewProvider(
      this.windowId,
      this.extensionContext,
    );

    // Sidebar
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "continue.continueGUIView",
        this.sidebar,
        {
          webviewOptions: { retainContextWhenHidden: true },
        },
      ),
    );
    resolveWebviewProtocol(this.sidebar.webviewProtocol);

    const inProcessMessenger = new InProcessMessenger<
      ToCoreProtocol,
      FromCoreProtocol
    >();

    new VsCodeMessenger(
      inProcessMessenger,
      this.sidebar.webviewProtocol,
      this.ide,
      verticalDiffManagerPromise,
      configHandlerPromise,
      this.editDecorationManager,
      context,
      this,
    );

    this.core = new Core(inProcessMessenger, this.ide);
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "cukii.delegateBridgeWorker",
        async () => {
          const token = process.env.AGENT_HUB_BROKER_UI_TOKEN;
          if (!token) {
            void vscode.window.showErrorMessage(
              "Cukii Bridge UI token unavailable. Reload VS Code after bridge setup.",
            );
            return;
          }
          let scopes: Awaited<ReturnType<typeof listBridgeScopes>>;
          try {
            scopes = await listBridgeScopes(token);
          } catch {
            void vscode.window.showErrorMessage("Cukii broker недоступен");
            return;
          }
          const candidates = (
            await Promise.all(
              scopes.map(async (scope) =>
                (await listBrokerSessions(token, scope.name)).map(
                  (session) => ({ scope, ...session }),
                ),
              ),
            )
          ).flat();
          const parent = await vscode.window.showQuickPick(
            candidates.map((item) => ({
              label: `${item.agent}: ${item.session_id}`,
              description: item.scope.name,
              item,
            })),
            { placeHolder: "Cukii: broker, который делегирует работу" },
          );
          if (!parent) return;
          const requestedWorker = await vscode.window.showQuickPick(
            ["auto", "deepseek", "claude", "codex", "grok", "cursor", "qwen"],
            {
              placeHolder: "Cukii: выберите vendor worker-а",
            },
          );
          if (!requestedWorker) return;
          const task = await vscode.window.showInputBox({
            prompt: "Конкретная задача для isolated worker-а",
            validateInput: (value) =>
              value.trim() ? undefined : "Задача не должна быть пустой",
          });
          if (!task) return;
          const taskId = `ui-${uuidv4().slice(0, 12)}`;
          try {
            const result = await delegateBridgeWorker({
              token,
              parent_session_id: parent.item.session_id,
              agent: requestedWorker,
              task_id: taskId,
              task,
            });
            const worker =
              typeof result.agent === "string" ? result.agent : requestedWorker;
            const session = result.session as
              | { session_id?: unknown }
              | undefined;
            const workerSessionId =
              typeof session?.session_id === "string"
                ? session.session_id
                : undefined;
            if (worker === "deepseek") {
              const lifecycleToken =
                typeof result.lifecycle_token === "string"
                  ? result.lifecycle_token
                  : undefined;
              if (!workerSessionId || !lifecycleToken)
                throw new Error("DeepSeek worker capability missing");
              // The VS Code provider remains the credential owner. We open a
              // fresh chat, bind it before input, then submit the broker task;
              // no provider key crosses the broker loopback boundary.
              await this.sidebar.webviewProtocol?.request(
                "newSession",
                undefined,
              );
              const chatSessionId = await this.sidebar.webviewProtocol?.request(
                "cukii/getActiveSessionId",
                undefined,
              );
              if (!chatSessionId)
                throw new Error("DeepSeek chat session missing");
              await this.core.bindBrokerLifecycle(
                chatSessionId,
                workerSessionId,
                lifecycleToken,
              );
              await this.sidebar.webviewProtocol?.request("userInput", {
                input: task,
              });
            }
            void vscode.window.showInformationMessage(
              `Cukii: ${worker} worker delegated from ${parent.item.agent} broker.`,
            );
          } catch {
            void vscode.window.showErrorMessage(
              "Cukii не смог делегировать worker-а",
            );
          }
        },
      ),
    );
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "cukii.openBridgeSession",
        async (requestedAgent?: unknown) => {
          const token = process.env.AGENT_HUB_BROKER_UI_TOKEN;
          if (!token) {
            void vscode.window.showErrorMessage(
              "Cukii Bridge UI token unavailable. Reload VS Code after bridge setup.",
            );
            return;
          }
          const agents = [
            "deepseek",
            "claude",
            "codex",
            "grok",
            "cursor",
            "qwen",
          ] as const;
          const agent =
            typeof requestedAgent === "string" &&
            agents.includes(requestedAgent as (typeof agents)[number])
              ? (requestedAgent as (typeof agents)[number])
              : await vscode.window.showQuickPick(agents, {
                  placeHolder: "Cukii: выберите native agent",
                });
          if (!agent) return;
          const role = await vscode.window.showQuickPick(["broker", "worker"], {
            placeHolder: "Cukii: выберите роль",
          });
          if (!role) return;
          let scopes: Awaited<ReturnType<typeof listBridgeScopes>>;
          try {
            scopes = await listBridgeScopes(token);
          } catch {
            void vscode.window.showErrorMessage("Cukii broker недоступен");
            return;
          }
          const scopePick = await vscode.window.showQuickPick(
            scopes.map((item) => ({
              label: item.name,
              description: item.root,
              scope: item,
            })),
            { placeHolder: "Cukii: выберите scope" },
          );
          if (!scopePick) return;
          const scope = scopePick.scope.name;
          let parent_session_id: string | undefined;
          if (role === "worker") {
            const parents = await listBrokerSessions(token, scope);
            const parent = await vscode.window.showQuickPick(
              parents.map((item) => ({
                label: `${item.agent}: ${item.session_id}`,
                sessionId: item.session_id,
              })),
              { placeHolder: "Cukii: выберите parent broker" },
            );
            if (!parent) return;
            parent_session_id = parent.sessionId;
          }
          const taskId = await vscode.window.showInputBox({
            prompt: "Task ID",
            value: `ui-${uuidv4().slice(0, 12)}`,
            validateInput: (value) =>
              /^[A-Za-z0-9_.-]+$/.test(value)
                ? undefined
                : "Только буквы, цифры, _, - и .",
          });
          if (!taskId) return;
          const chatSessionId =
            agent === "deepseek"
              ? await this.sidebar.webviewProtocol?.request(
                  "cukii/getActiveSessionId",
                  undefined,
                )
              : undefined;
          if (agent === "deepseek" && !chatSessionId) {
            void vscode.window.showErrorMessage(
              "Сначала откройте нужную пустую DeepSeek chat-вкладку, затем повторите Open Bridge Session.",
            );
            return;
          }
          try {
            const result = await openBridgeSession({
              token,
              session_id: `ui-${uuidv4()}`,
              agent,
              role,
              scope,
              task_id: taskId,
              ...(parent_session_id ? { parent_session_id } : {}),
            });
            const bridgeSessionId =
              typeof (result.session as { session_id?: unknown } | undefined)
                ?.session_id === "string"
                ? (result.session as { session_id: string }).session_id
                : undefined;
            const lifecycleToken =
              typeof result.lifecycle_token === "string"
                ? result.lifecycle_token
                : undefined;
            if (bridgeSessionId) {
              await context.workspaceState.update("cukii.lastBridgeSession", {
                session_id: bridgeSessionId,
                agent,
                role,
                scope,
                task_id: taskId,
                parent_session_id,
              });
            }
            if (agent === "deepseek" && bridgeSessionId && lifecycleToken) {
              await this.core.bindBrokerLifecycle(
                chatSessionId!,
                bridgeSessionId,
                lifecycleToken,
              );
              void vscode.window.showInformationMessage(
                `Cukii: DeepSeek ${role} привязан к выбранной chat-вкладке.`,
              );
            } else if (
              (agent === "claude" ||
                agent === "codex" ||
                agent === "grok" ||
                agent === "cursor" ||
                agent === "qwen") &&
              bridgeSessionId
            ) {
              // shellPath/args are fixed constants; neither task text nor any user
              // input is ever interpolated into a shell command.
              const worktree = (
                result.session as { worktree?: unknown } | undefined
              )?.worktree;
              if (typeof worktree !== "string" || !worktree)
                throw new Error("broker did not provision module worktree");
              const root = worktree;
              const command = bridgeTerminalLaunchSpec(
                agent,
                root,
                bridgeSessionId,
                role,
                scope,
              );
              const terminal = vscode.window.createTerminal({
                name: `Cukii · ${agent} · ${role}`,
                cwd: command.cwd,
                shellPath: command.program,
                shellArgs: command.args,
                env: command.env,
              });
              terminal.show();
              void vscode.window.showInformationMessage(
                `Cukii: native ${agent} ${role} открыт в изолированном module worktree; authenticated broker adapter ещё не подключён.`,
              );
            } else {
              void vscode.window.showInformationMessage(
                `Cukii: ${agent} ${role} открыт (${String(result.status)}; transport ещё не подключён)`,
              );
            }
          } catch {
            void vscode.window.showErrorMessage(
              "Cukii не открыл bridge session",
            );
          }
        },
      ),
    );
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "cukii.recoverBridgeSession",
        async () => {
          const token = process.env.AGENT_HUB_BROKER_UI_TOKEN;
          const saved = context.workspaceState.get<{
            session_id: string;
            agent: string;
            role: string;
            scope: string;
            task_id: string;
            parent_session_id?: string;
          }>("cukii.lastBridgeSession");
          if (!token || !saved) {
            void vscode.window.showErrorMessage(
              "Нет сохранённой bridge session для recovery.",
            );
            return;
          }
          try {
            const result = await recoverBridgeSession({ token, ...saved });
            const lifecycleToken =
              typeof result.lifecycle_token === "string"
                ? result.lifecycle_token
                : undefined;
            if (saved.agent === "deepseek" && lifecycleToken) {
              const chatSessionId = await this.sidebar.webviewProtocol?.request(
                "cukii/getActiveSessionId",
                undefined,
              );
              if (!chatSessionId)
                throw new Error("DeepSeek chat session unavailable");
              await this.core.bindBrokerLifecycle(
                chatSessionId,
                saved.session_id,
                lifecycleToken,
              );
            }
            void vscode.window.showInformationMessage(
              `Cukii: bridge session ${saved.session_id} восстановлена с новым handshake.`,
            );
          } catch {
            void vscode.window.showErrorMessage(
              "Cukii не смог восстановить bridge session",
            );
          }
        },
      ),
    );
    this.configHandler = this.core.configHandler;
    resolveConfigHandler?.(this.configHandler);

    void this.configHandler.loadConfig();

    this.verticalDiffManager = new VerticalDiffManager(
      this.sidebar.webviewProtocol,
      this.editDecorationManager,
      this.ide,
    );
    resolveVerticalDiffManager?.(this.verticalDiffManager);

    void this.configHandler.loadConfig().then(async ({ config }) => {
      const shouldUseFullFileDiff = await getUsingFullFileDiff();
      this.completionProvider.updateUsingFullFileDiff(shouldUseFullFileDiff);
      selectionManager.updateUsingFullFileDiff(shouldUseFullFileDiff);

      const { verticalDiffCodeLens } = registerAllCodeLensProviders(
        context,
        this.verticalDiffManager.fileUriToCodeLens,
        config,
      );

      this.verticalDiffManager.refreshCodeLens =
        verticalDiffCodeLens.refresh.bind(verticalDiffCodeLens);
    });

    this.configHandler.onConfigUpdate(
      async ({ config: newConfig, configLoadInterrupted }) => {
        const shouldUseFullFileDiff = await getUsingFullFileDiff();
        this.completionProvider.updateUsingFullFileDiff(shouldUseFullFileDiff);
        selectionManager.updateUsingFullFileDiff(shouldUseFullFileDiff);

        await this.updateNextEditState(context);

        if (configLoadInterrupted) {
          // Show error in status bar
          setupStatusBar(undefined, undefined, true);
        } else if (newConfig) {
          setupStatusBar(undefined, undefined, false);

          registerAllCodeLensProviders(
            context,
            this.verticalDiffManager.fileUriToCodeLens,
            newConfig,
          );
        }
      },
    );

    // Tab autocomplete
    const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const enabled = config.get<boolean>("enableTabAutocomplete");

    // Register inline completion provider
    setupStatusBar(
      enabled ? StatusBarStatus.Enabled : StatusBarStatus.Disabled,
    );
    this.completionProvider = new ContinueCompletionProvider(
      this.configHandler,
      this.ide,
      this.sidebar.webviewProtocol,
      usingFullFileDiff,
    );
    context.subscriptions.push(
      vscode.languages.registerInlineCompletionItemProvider(
        [{ pattern: "**" }],
        this.completionProvider,
      ),
    );

    // Handle uri events
    this.uriHandler.event((uri) => {
      const queryParams = new URLSearchParams(uri.query);
      let profileId = queryParams.get("profile_id");

      this.core.invoke("config/refreshProfiles", {
        reason: "VS Code deep link",
        selectProfileId:
          profileId === "null" ? undefined : (profileId ?? undefined),
      });
    });

    // Battery
    this.battery = new Battery();
    context.subscriptions.push(this.battery);
    context.subscriptions.push(monitorBatteryChanges(this.battery));

    // FileSearch
    this.fileSearch = new FileSearch(this.ide);
    registerAllPromptFilesCompletionProviders(
      context,
      this.fileSearch,
      this.ide,
    );

    const quickEdit = new QuickEdit(
      this.verticalDiffManager,
      this.configHandler,
      this.sidebar.webviewProtocol,
      this.ide,
      context,
      this.fileSearch,
    );

    // LLM Log view
    this.consoleView = new ContinueConsoleWebviewViewProvider(
      this.windowId,
      this.extensionContext,
      this.core.llmLogger,
    );

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "continue.continueConsoleView",
        this.consoleView,
      ),
    );

    // Commands
    registerAllCommands(
      context,
      this.ide,
      context,
      this.sidebar,
      this.consoleView,
      this.configHandler,
      this.verticalDiffManager,
      this.battery,
      quickEdit,
      this.core,
      this.editDecorationManager,
    );

    // Disabled due to performance issues
    // registerDebugTracker(this.sidebar.webviewProtocol, this.ide);

    // Listen for file saving - use global file watcher so that changes
    // from outside the window are also caught
    fs.watchFile(getConfigJsonPath(), { interval: 1000 }, async (stats) => {
      if (stats.size === 0) {
        return;
      }
      await this.configHandler.reloadConfig(
        "Global JSON config updated - fs file watch",
      );
    });

    fs.watchFile(
      getConfigYamlPath("vscode"),
      { interval: 1000 },
      async (stats) => {
        if (stats.size === 0) {
          return;
        }
        await this.configHandler.reloadConfig(
          "Global YAML config updated - fs file watch",
        );
      },
    );

    fs.watchFile(getConfigTsPath(), { interval: 1000 }, (stats) => {
      if (stats.size === 0) {
        return;
      }
      void this.configHandler.reloadConfig("config.ts updated - fs file watch");
    });

    // watch global rules directory for changes
    const globalRulesDir = path.join(getContinueGlobalPath(), "rules");
    if (fs.existsSync(globalRulesDir)) {
      fs.watch(globalRulesDir, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith(".md")) {
          void this.configHandler.reloadConfig(
            "Global rules directory updated - fs file watch",
          );
        }
      });
    }

    // Initialize document content cache for tracking pre-edit content
    vscode.workspace.onDidOpenTextDocument((document) => {
      initDocumentContentCache(document);
    });

    // Initialize cache for all currently open documents
    for (const document of vscode.workspace.textDocuments) {
      initDocumentContentCache(document);
    }

    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (event.contentChanges.length > 0) {
        selectionManager.documentChanged();
      }

      const editInfo = await handleTextDocumentChange(
        event,
        this.configHandler,
        this.ide,
        this.completionProvider,
        getDefinitionsFromLsp,
      );

      if (editInfo) this.core.invoke("files/smallEdit", editInfo);
    });

    vscode.workspace.onDidSaveTextDocument(async (event) => {
      this.core.invoke("files/changed", {
        uris: [event.uri.toString()],
      });
    });

    vscode.workspace.onDidDeleteFiles(async (event) => {
      this.core.invoke("files/deleted", {
        uris: event.files.map((uri) => uri.toString()),
      });
    });

    vscode.workspace.onDidCloseTextDocument(async (event) => {
      clearDocumentContentCache(event.uri.toString());
      this.core.invoke("files/closed", {
        uris: [event.uri.toString()],
      });
    });

    vscode.workspace.onDidCreateFiles(async (event) => {
      this.core.invoke("files/created", {
        uris: event.files.map((uri) => uri.toString()),
      });
    });

    vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
      const dirs = vscode.workspace.workspaceFolders?.map(
        (folder) => folder.uri,
      );

      this.ideUtils.setWokspaceDirectories(dirs);

      this.core.invoke("index/forceReIndex", {
        dirs: [
          ...event.added.map((folder) => folder.uri.toString()),
          ...event.removed.map((folder) => folder.uri.toString()),
        ],
      });
    });

    // TODO merge this and re-enable https://github.com/continuedev/continue/pull/8364
    // vscode.workspace.onDidOpenTextDocument(async (event) => {
    //   const ast = await getAst(event.fileName, event.getText());
    //   if (ast) {
    //     DocumentHistoryTracker.getInstance().addDocument(
    //       localPathOrUriToPath(event.fileName),
    //       event.getText(),
    //       ast,
    //     );
    //   }
    // });

    // When GitHub sign-in status changes, reload config
    vscode.authentication.onDidChangeSessions(async (e) => {
      if (e.provider.id === "github") {
        this.configHandler.reloadConfig("Github sign-in status changed");
      }
    });

    // Listen for editor changes to clean up decorations when editor closes.
    vscode.window.onDidChangeVisibleTextEditors(async () => {
      // If our active editor is no longer visible, clear decorations.
      console.log("deleteChain called from onDidChangeVisibleTextEditors");
      await NextEditProvider.getInstance().deleteChain();
    });

    // Listen for selection changes to hide tooltip when cursor moves.
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(async (e) => {
        this.broadcastActiveEditorSelection();
        await selectionManager.handleSelectionChange(e);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.broadcastActiveEditorSelection();
      }),
    );

    // Refresh index when branch is changed
    void this.ide.getWorkspaceDirs().then((dirs) =>
      dirs.forEach(async (dir) => {
        const repo = await this.ide.getRepo(dir);
        if (repo) {
          repo.state.onDidChange(() => {
            // args passed to this callback are always undefined, so keep track of previous branch
            const currentBranch = repo?.state?.HEAD?.name;
            if (currentBranch) {
              if (this.PREVIOUS_BRANCH_FOR_WORKSPACE_DIR[dir]) {
                if (
                  currentBranch !== this.PREVIOUS_BRANCH_FOR_WORKSPACE_DIR[dir]
                ) {
                  // Trigger refresh of index only in this directory
                  this.core.invoke("index/forceReIndex", { dirs: [dir] });
                }
              }

              this.PREVIOUS_BRANCH_FOR_WORKSPACE_DIR[dir] = currentBranch;
            }
          });
        }
      }),
    );

    // Register a content provider for the readonly virtual documents
    const documentContentProvider = new (class
      implements vscode.TextDocumentContentProvider
    {
      // emitter and its event
      onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
      onDidChange = this.onDidChangeEmitter.event;

      provideTextDocumentContent(uri: vscode.Uri): string {
        return uri.query;
      }
    })();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        VsCodeExtension.continueVirtualDocumentScheme,
        documentContentProvider,
      ),
    );

    const linkProvider = vscode.languages.registerDocumentLinkProvider(
      { language: "yaml" },
      new ConfigYamlDocumentLinkProvider(),
    );
    context.subscriptions.push(linkProvider);

    this.ide.onDidChangeActiveTextEditor((filepath) => {
      void this.core.invoke("files/opened", { uris: [filepath] });
    });

    // initializes openedFileLruCache with files that are already open when the extension is activated
    let initialOpenedFilePaths = this.ideUtils
      .getOpenFiles()
      .map((uri) => uri.toString());
    this.core.invoke("files/opened", { uris: initialOpenedFilePaths });

    // This is how you would enable/disable next edit in the autocomplete menu.
    // See extensions/vscode/src/autocomplete/statusBar.ts.
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration(EXTENSION_NAME)) {
        const settings = await this.ide.getIdeSettings();
        void this.core.invoke("config/ideSettingsUpdate", settings);

        if (event.affectsConfiguration(`${EXTENSION_NAME}.enableNextEdit`)) {
          await this.updateNextEditState(context);
        }
      }
    });
  }

  static continueVirtualDocumentScheme = EXTENSION_NAME;

  // eslint-disable-next-line @typescript-eslint/naming-convention
  private PREVIOUS_BRANCH_FOR_WORKSPACE_DIR: { [dir: string]: string } = {};

  registerCustomContextProvider(contextProvider: IContextProvider) {
    this.configHandler.registerCustomContextProvider(contextProvider);
  }

  public activateNextEdit() {
    this.completionProvider.activateNextEdit();
  }

  public deactivateNextEdit() {
    this.completionProvider.deactivateNextEdit();
  }
}
