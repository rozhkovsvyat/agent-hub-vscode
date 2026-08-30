/* eslint-disable @typescript-eslint/naming-convention */
import * as fs from "node:fs";

import { ContextMenuConfig, ILLM, ModelInstaller } from "core";
import { CompletionProvider } from "core/autocomplete/CompletionProvider";
import { ConfigHandler } from "core/config/ConfigHandler";
import { EXTENSION_NAME } from "core/util/constants";
import { Core } from "core/core";
import { walkDirAsync } from "core/indexing/walkDir";
import { isModelInstaller } from "core/llm";
import { NextEditLoggingService } from "core/nextEdit/NextEditLoggingService";
import { startLocalLemonade } from "core/util/lemonadeHelper";
import { startLocalOllama } from "core/util/ollamaHelper";
import {
  getConfigJsonPath,
  getConfigYamlPath,
  setConfigFilePermissions,
} from "core/util/paths";
import * as vscode from "vscode";
import * as YAML from "yaml";

import { convertJsonToYamlConfig } from "../../../packages/config-yaml/dist";

import {
  getAutocompleteStatusBarDescription,
  getAutocompleteStatusBarTitle,
  getNextEditMenuItems,
  getStatusBarStatus,
  getStatusBarStatusFromQuickPickItemLabel,
  handleNextEditToggle,
  isNextEditToggleLabel,
  quickPickStatusText,
  setupStatusBar,
  StatusBarStatus,
} from "./autocomplete/statusBar";
import { ContinueConsoleWebviewViewProvider } from "./ContinueConsoleWebviewViewProvider";
import { ContinueGUIWebviewViewProvider } from "./ContinueGUIWebviewViewProvider";
import {
  cukiiPanelRegistry as fullScreenPanels,
  CUKII_BLANK_PANEL_TITLE,
  getCukiiRenameTarget,
  isPersistableCukiiTitle,
  listCukiiRenameTargets,
  listOpenCukiiPanels,
  syncCukiiPanelTitleForSession,
  type CukiiPanelHost,
} from "./cukiiPanelRegistry";
import { processDiff } from "./diff/processDiff";
import { VerticalDiffManager } from "./diff/vertical/manager";
import EditDecorationManager from "./quickEdit/EditDecorationManager";
import { QuickEdit, QuickEditShowParams } from "./quickEdit/QuickEditQuickPick";
import {
  addCodeToContextFromRange,
  addEntireFileToContext,
  addHighlightedCodeToContext,
} from "./util/addCode";
import { Battery } from "./util/battery";
import { getMetaKeyLabel } from "./util/util";
import { getExtensionUri, openEditorAndRevealRange } from "./util/vscode";
import { VsCodeIde } from "./VsCodeIde";

export const FULL_SCREEN_VIEW_TYPE = "cukii.fullScreenChat";

let nextFullScreenPanelId = 1;

/**
 * Наполняет полноэкранную панель и берёт её под учёт.
 *
 * Общий код для двух путей: создание по команде и **восстановление** таба,
 * который VS Code вернул после перезапуска окна. Второй путь раньше
 * отсутствовал вовсе, и восстановленный таб оставался навсегда пустым.
 */
function applyCukiiPanelChrome(panel: vscode.WebviewPanel, title?: string) {
  panel.iconPath = {
    light: vscode.Uri.joinPath(getExtensionUri(), "media", "cukii-title.svg"),
    dark: vscode.Uri.joinPath(getExtensionUri(), "media", "cukii-title.svg"),
  };
  panel.title = isPersistableCukiiTitle(title)
    ? title.trim()
    : CUKII_BLANK_PANEL_TITLE;
}

function attachFullScreenPanel(
  panel: vscode.WebviewPanel,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  initialSessionId?: string,
  initialTitle?: string,
  suppressInitialChordCharacter = false,
) {
  const panelId = `cukii-panel-${nextFullScreenPanelId++}`;
  const protocol = sidebar.webviewProtocol.cloneHandlers();
  fullScreenPanels.add(panelId, { panel, protocol }, initialSessionId);
  applyCukiiPanelChrome(panel, initialTitle);

  const notifyPanelList = () => {
    sidebar.webviewProtocol.send(
      "cukii/openChatPanelsChanged",
      listOpenCukiiPanels(),
    );
  };

  notifyPanelList();

  if (isPersistableCukiiTitle(initialTitle)) {
    fullScreenPanels.updateTitle(panelId, initialTitle.trim());
  }

  protocol.on("cukii/panelSessionChanged", ({ data }) => {
    fullScreenPanels.updateSession(panelId, data.sessionId);
    if (isPersistableCukiiTitle(data.title)) {
      fullScreenPanels.updateTitle(panelId, data.title.trim());
      panel.title = data.title.trim();
    }
    notifyPanelList();
  });

  // A session can disappear after the command verified it but before the
  // freshly-created webview finishes loading it. Dispose this provisional
  // panel instead of turning it into a misleading blank Cukii tab.
  protocol.on("cukii/initialSessionLoadFailed", ({ data }) => {
    if (fullScreenPanels.get(panelId)?.sessionId === data.sessionId) {
      panel.dispose();
    }
  });

  panel.webview.html = sidebar.getSidebarContent(
    extensionContext,
    panel,
    undefined,
    undefined,
    true,
    protocol,
    "chat",
    initialSessionId,
    panelId,
    suppressInitialChordCharacter,
  );

  panel.onDidChangeViewState(({ webviewPanel }) => {
    if (webviewPanel.active) {
      fullScreenPanels.markActive(panelId);
    }
  });

  panel.onDidDispose(
    () => {
      protocol.dispose();
      fullScreenPanels.remove(panelId);
      notifyPanelList();
    },
    null,
    extensionContext.subscriptions,
  );
}

/**
 * Восстановление полноэкранного таба после перезапуска окна.
 *
 * Без сериализатора VS Code возвращает оболочку таба, но HTML в неё уже никто
 * не кладёт: панель остаётся пустой серой, и это переживает и reload, и
 * рестарт. Регистрируется на активации, иначе VS Code выбросит восстановленный
 * webview до того, как мы о нём узнаем.
 */
export function registerFullScreenPanelSerializer(
  context: vscode.ExtensionContext,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
) {
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(FULL_SCREEN_VIEW_TYPE, {
      async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: { sessionId?: string; title?: string } | undefined,
      ) {
        panel.webview.options = { enableScripts: true };
        attachFullScreenPanel(
          panel,
          extensionContext,
          sidebar,
          state?.sessionId,
          state?.title,
        );
      },
    }),
  );
}

function focusGUI() {
  const activePanel = fullScreenPanels.lastActive();
  if (activePanel) {
    activePanel.panel.panel.reveal();
    return;
  }
  vscode.commands.executeCommand("continue.continueGUIView.focus");
}

function hideGUI() {
  const activePanel = fullScreenPanels.lastActive();
  if (activePanel) {
    activePanel.panel.panel.dispose();
    return;
  }
  vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
}

function waitForSidebarReady(
  sidebar: ContinueGUIWebviewViewProvider,
  timeout: number,
  interval: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const checkReadyState = () => {
      if (sidebar.isReady) {
        resolve(true);
      } else if (Date.now() - startTime >= timeout) {
        resolve(false); // Timed out
      } else {
        setTimeout(checkReadyState, interval);
      }
    };

    checkReadyState();
  });
}

// Copy everything over from extension.ts
const getCommandsMap: (
  ide: VsCodeIde,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  consoleView: ContinueConsoleWebviewViewProvider,
  configHandler: ConfigHandler,
  verticalDiffManager: VerticalDiffManager,
  battery: Battery,
  quickEdit: QuickEdit,
  core: Core,
  editDecorationManager: EditDecorationManager,
) => { [command: string]: (...args: any) => any } = (
  ide,
  extensionContext,
  sidebar,
  consoleView,
  configHandler,
  verticalDiffManager,
  battery,
  quickEdit,
  core,
  editDecorationManager,
) => {
  async function ensureActiveChatPanel(): Promise<CukiiPanelHost | undefined> {
    const active = fullScreenPanels.lastActive();
    if (active) {
      active.panel.panel.reveal();
      return active.panel;
    }
    await vscode.commands.executeCommand("continue.openInNewWindow");
    return fullScreenPanels.lastActive()?.panel;
  }

  /**
   * Streams an inline edit to the vertical diff manager.
   *
   * This function retrieves the configuration, determines the appropriate model title,
   * increments the FTC count, and then streams an edit to the
   * vertical diff manager.
   *
   * @param  promptName - The key for the prompt in the context menu configuration.
   * @param  fallbackPrompt - The prompt to use if the configured prompt is not available.
   * @param  [range] - Optional. The range to edit if provided.
   * @returns
   */
  async function streamInlineEdit(
    promptName: keyof ContextMenuConfig,
    fallbackPrompt: string,
    range?: vscode.Range,
  ) {
    const { config } = await configHandler.loadConfig();
    if (!config) {
      throw new Error("Config not loaded");
    }

    const llm =
      config.selectedModelByRole.edit ?? config.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No edit or chat model selected");
    }

    void sidebar.webviewProtocol.request("incrementFtc", undefined);

    await verticalDiffManager.streamEdit({
      input:
        config.experimental?.contextMenuPrompts?.[promptName] ?? fallbackPrompt,
      llm,
      range,
      rulesToInclude: config.rules,
      isApply: false,
    });
  }

  return {
    "continue.acceptDiff": async (newFileUri?: string, streamId?: string) => {
      void processDiff(
        "accept",
        sidebar,
        ide,
        core,
        verticalDiffManager,
        newFileUri,
        streamId,
      );
    },

    "continue.rejectDiff": async (newFileUri?: string, streamId?: string) => {
      void processDiff(
        "reject",
        sidebar,
        ide,
        core,
        verticalDiffManager,
        newFileUri,
        streamId,
      );
    },
    "continue.acceptVerticalDiffBlock": (fileUri?: string, index?: number) => {
      verticalDiffManager.acceptRejectVerticalDiffBlock(true, fileUri, index);
    },
    "continue.rejectVerticalDiffBlock": (fileUri?: string, index?: number) => {
      verticalDiffManager.acceptRejectVerticalDiffBlock(false, fileUri, index);
    },
    "continue.quickFix": async (
      range: vscode.Range,
      diagnosticMessage: string,
    ) => {
      const prompt = `Please explain the cause of this error and how to solve it: ${diagnosticMessage}`;

      addCodeToContextFromRange(range, sidebar.webviewProtocol, prompt);

      vscode.commands.executeCommand("continue.continueGUIView.focus");
    },
    "continue.defaultQuickAction": async (args: QuickEditShowParams) => {
      vscode.commands.executeCommand("continue.focusEdit", args);
    },
    "continue.customQuickActionSendToChat": async (
      prompt: string,
      range: vscode.Range,
    ) => {
      addCodeToContextFromRange(range, sidebar.webviewProtocol, prompt);

      vscode.commands.executeCommand("continue.continueGUIView.focus");
    },
    "continue.customQuickActionStreamInlineEdit": async (
      prompt: string,
      range: vscode.Range,
    ) => {
      streamInlineEdit("docstring", prompt, range);
    },
    "continue.codebaseForceReIndex": async () => {
      void core.invoke("index/forceReIndex", undefined);
    },
    "continue.rebuildCodebaseIndex": async () => {
      void core.invoke("index/forceReIndex", { shouldClearIndexes: true });
    },
    "continue.docsIndex": async () => {
      void core.invoke("context/indexDocs", { reIndex: false });
    },
    "continue.docsReIndex": async () => {
      void core.invoke("context/indexDocs", { reIndex: true });
    },
    "continue.focusContinueInput": async () => {
      const host = await ensureActiveChatPanel();
      if (!host) {
        return;
      }
      void host.protocol.request(
        "focusContinueInputWithNewSession",
        undefined,
        false,
      );
      void addHighlightedCodeToContext(host.protocol);
    },
    "continue.focusContinueInputWithoutClear": async () => {
      const host = await ensureActiveChatPanel();
      if (!host) {
        return;
      }
      void host.protocol.request("focusContinueInputWithoutClear", undefined);
      void addHighlightedCodeToContext(host.protocol);
    },
    "continue.focusCuKiiInput": async () => {
      await vscode.commands.executeCommand("continue.focusContinueInput");
    },
    "continue.focusCuKiiInputWithoutClear": async () => {
      await vscode.commands.executeCommand(
        "continue.focusContinueInputWithoutClear",
      );
    },
    // QuickEditShowParams are passed from CodeLens, temp fix
    // until we update to new params specific to Edit
    "continue.focusEdit": async (args?: QuickEditShowParams) => {
      const host = await ensureActiveChatPanel();
      void host?.protocol.request("focusEdit", undefined);
    },
    "continue.exitEditMode": async () => {
      editDecorationManager.clear();
      void fullScreenPanels
        .lastActive()
        ?.panel.protocol.request("exitEditMode", undefined);
    },
    "continue.writeCommentsForCode": async () => {
      streamInlineEdit(
        "comment",
        "Write comments for this code. Do not change anything about the code itself.",
      );
    },
    "continue.writeDocstringForCode": async () => {
      void streamInlineEdit(
        "docstring",
        "Write a docstring for this code. Do not change anything about the code itself.",
      );
    },
    "continue.fixCode": async () => {
      streamInlineEdit(
        "fix",
        "Fix this code. If it is already 100% correct, simply rewrite the code.",
      );
    },
    "continue.optimizeCode": async () => {
      streamInlineEdit("optimize", "Optimize this code");
    },
    "continue.fixGrammar": async () => {
      streamInlineEdit(
        "fixGrammar",
        "If there are any grammar or spelling mistakes in this writing, fix them. Do not make other large changes to the writing.",
      );
    },
    "continue.clearConsole": async () => {
      consoleView.clearLog();
    },
    "continue.viewLogs": async () => {
      vscode.commands.executeCommand("workbench.action.toggleDevTools");
    },
    "continue.debugTerminal": async () => {
      const terminalContents = await ide.getTerminalContents();

      vscode.commands.executeCommand("continue.continueGUIView.focus");

      sidebar.webviewProtocol?.request("userInput", {
        input: `I got the following error, can you please help explain how to fix it?\n\n${terminalContents.trim()}`,
      });
    },
    "continue.hideInlineTip": () => {
      vscode.workspace
        .getConfiguration(EXTENSION_NAME)
        .update("showInlineTip", false, vscode.ConfigurationTarget.Global);
    },

    // Commands without keyboard shortcuts
    "continue.addModel": () => {
      vscode.commands.executeCommand("continue.continueGUIView.focus");
      sidebar.webviewProtocol?.request("addModel", undefined);
    },
    "continue.newSession": () => {
      void vscode.commands.executeCommand("continue.openInNewWindow");
    },

    "continue.shareSession": async (sessionId: string | undefined) => {
      if (!sessionId) {
        sessionId = await sidebar.webviewProtocol?.request(
          "getCurrentSessionId",
          undefined,
        );
      }
      if (!sessionId) {
        void vscode.window.showErrorMessage(
          "No session ID found. Please start a new session first.",
        );
        return;
      }
      //let user select the destination folder
      const destinationFolder = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select Destination Folder",
      });
      if (!destinationFolder || destinationFolder.length === 0) {
        return;
      }

      try {
        // despite core.invoke not being async, we still need to await it, because the 'history/share' command is async
        // if not awaited, then errors will not be caught.
        await core.invoke("history/share", {
          id: sessionId,
          outputDir: destinationFolder[0].fsPath,
        });
      } catch (error) {
        const errorMessage = `Failed to save session: ${error instanceof Error ? error.message : String(error)}`;
        void vscode.window.showErrorMessage(errorMessage);
      }
    },
    "continue.viewHistory": () => {
      vscode.commands.executeCommand("continue.navigateTo", "/history", true);
    },
    "continue.focusContinueSessionId": async (
      sessionId: string | undefined,
    ) => {
      if (!sessionId) {
        sessionId = await vscode.window.showInputBox({
          prompt: "Enter the Session ID",
        });
      }
      void sidebar.webviewProtocol?.request("focusContinueSessionId", {
        sessionId,
      });
    },
    "continue.applyCodeFromChat": () => {
      void sidebar.webviewProtocol.request("applyCodeFromChat", undefined);
    },
    "continue.openConfigPage": () => {
      vscode.commands.executeCommand("continue.navigateTo", "/config", false);
    },
    "continue.selectFilesAsContext": async (
      firstUri: vscode.Uri,
      uris: vscode.Uri[],
    ) => {
      if (uris === undefined) {
        throw new Error("No files were selected");
      }

      vscode.commands.executeCommand("continue.continueGUIView.focus");

      for (const uri of uris) {
        // If it's a folder, add the entire folder contents recursively by using walkDir (to ignore ignored files)
        const isDirectory = await vscode.workspace.fs
          .stat(uri)
          ?.then((stat) => stat.type === vscode.FileType.Directory);
        if (isDirectory) {
          for await (const fileUri of walkDirAsync(uri.toString(), ide, {
            source: "vscode continue.selectFilesAsContext command",
          })) {
            await addEntireFileToContext(
              vscode.Uri.parse(fileUri),
              sidebar.webviewProtocol,
              ide.ideUtils,
            );
          }
        } else {
          await addEntireFileToContext(
            uri,
            sidebar.webviewProtocol,
            ide.ideUtils,
          );
        }
      }
    },
    "continue.logAutocompleteOutcome": (
      completionId: string,
      completionProvider: CompletionProvider,
    ) => {
      completionProvider.accept(completionId);
    },
    "continue.logNextEditOutcomeAccept": (
      completionId: string,
      nextEditLoggingService: NextEditLoggingService,
    ) => {
      nextEditLoggingService.accept(completionId);
    },
    "continue.logNextEditOutcomeReject": (
      completionId: string,
      nextEditLoggingService: NextEditLoggingService,
    ) => {
      nextEditLoggingService.reject(completionId);
    },
    "continue.toggleTabAutocompleteEnabled": () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const enabled = config.get("enableTabAutocomplete");
      const pauseOnBattery = config.get<boolean>(
        "pauseTabAutocompleteOnBattery",
      );
      if (!pauseOnBattery || battery.isACConnected()) {
        config.update(
          "enableTabAutocomplete",
          !enabled,
          vscode.ConfigurationTarget.Global,
        );
      } else {
        if (enabled) {
          const paused = getStatusBarStatus() === StatusBarStatus.Paused;
          if (paused) {
            setupStatusBar(StatusBarStatus.Enabled);
          } else {
            config.update(
              "enableTabAutocomplete",
              false,
              vscode.ConfigurationTarget.Global,
            );
          }
        } else {
          setupStatusBar(StatusBarStatus.Paused);
          config.update(
            "enableTabAutocomplete",
            true,
            vscode.ConfigurationTarget.Global,
          );
        }
      }
    },
    "continue.forceAutocomplete": async () => {
      // 1. Explicitly hide any existing suggestion. This clears VS Code's cache for the current position.
      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      // 2. Now trigger a new one. VS Code has no cached suggestion, so it's forced to call our provider.
      await vscode.commands.executeCommand(
        "editor.action.inlineSuggest.trigger",
      );
    },

    "continue.openTabAutocompleteConfigMenu": async () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const quickPick = vscode.window.createQuickPick();

      const { config: continueConfig } = await configHandler.loadConfig();
      const autocompleteModels =
        continueConfig?.modelsByRole.autocomplete ?? [];
      const selected =
        continueConfig?.selectedModelByRole?.autocomplete?.title ?? undefined;

      // Toggle between Disabled, Paused, and Enabled
      const pauseOnBattery =
        config.get<boolean>("pauseTabAutocompleteOnBattery") &&
        !battery.isACConnected();
      const currentStatus = getStatusBarStatus();

      let targetStatus: StatusBarStatus | undefined;
      if (pauseOnBattery) {
        // Cycle from Disabled -> Paused -> Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Paused
            ? StatusBarStatus.Enabled
            : currentStatus === StatusBarStatus.Disabled
              ? StatusBarStatus.Paused
              : StatusBarStatus.Disabled;
      } else {
        // Toggle between Disabled and Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Disabled
            ? StatusBarStatus.Enabled
            : StatusBarStatus.Disabled;
      }

      const nextEditEnabled = config.get<boolean>("enableNextEdit") ?? false;

      quickPick.items = [
        {
          label: "$(gear) Open settings",
        },
        {
          label: "$(comment) Open chat",
          description: getMetaKeyLabel() + " + L",
        },
        {
          label: "$(screen-full) Open full screen chat",
          description:
            getMetaKeyLabel() + " + K, " + getMetaKeyLabel() + " + M",
        },
        {
          label: quickPickStatusText(targetStatus),
          description:
            getMetaKeyLabel() + " + K, " + getMetaKeyLabel() + " + A",
        },
        ...getNextEditMenuItems(currentStatus, nextEditEnabled),
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: "Switch model",
        },
        ...autocompleteModels.map((model) => ({
          label: getAutocompleteStatusBarTitle(selected, model),
          description: getAutocompleteStatusBarDescription(selected, model),
        })),
      ];
      quickPick.onDidAccept(() => {
        const selectedOption = quickPick.selectedItems[0].label;
        const targetStatus =
          getStatusBarStatusFromQuickPickItemLabel(selectedOption);

        if (targetStatus !== undefined) {
          setupStatusBar(targetStatus);
          config.update(
            "enableTabAutocomplete",
            targetStatus === StatusBarStatus.Enabled,
            vscode.ConfigurationTarget.Global,
          );
        } else if (isNextEditToggleLabel(selectedOption)) {
          handleNextEditToggle(selectedOption, config);
        } else if (
          autocompleteModels.some((model) => model.title === selectedOption)
        ) {
          if (core.configHandler.currentProfile?.profileDescription.id) {
            void core.invoke("config/updateSelectedModel", {
              profileId:
                core.configHandler.currentProfile?.profileDescription.id,
              role: "autocomplete",
              title: selectedOption,
            });
          }
        } else if (selectedOption === "$(comment) Open chat") {
          vscode.commands.executeCommand("continue.focusContinueInput");
        } else if (selectedOption === "$(screen-full) Open full screen chat") {
          vscode.commands.executeCommand("continue.openInNewWindow");
        } else if (selectedOption === "$(gear) Open settings") {
          vscode.commands.executeCommand("continue.navigateTo", "/config");
        }

        quickPick.dispose();
      });
      quickPick.show();
    },
    "continue.navigateTo": (path: string, toggle: boolean) => {
      sidebar.webviewProtocol?.request("navigateTo", { path, toggle });
      focusGUI();
    },
    "continue.startLocalOllama": () => {
      startLocalOllama(ide);
    },
    "continue.startLocalLemonade": () => {
      startLocalLemonade(ide);
    },
    "continue.installModel": async (
      modelName: string,
      llmProvider: ILLM | undefined,
    ) => {
      try {
        if (!isModelInstaller(llmProvider)) {
          const msg = llmProvider
            ? `LLM provider '${llmProvider.providerName}' does not support installing models`
            : "Missing LLM Provider";
          throw new Error(msg);
        }
        await installModelWithProgress(modelName, llmProvider);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(
          `Failed to install '${modelName}': ${message}`,
        );
      }
    },
    "continue.convertConfigJsonToConfigYaml": async () => {
      const configJson = fs.readFileSync(getConfigJsonPath(), "utf-8");
      const parsed = JSON.parse(configJson);
      const configYaml = convertJsonToYamlConfig(parsed);

      const configYamlPath = getConfigYamlPath();
      fs.writeFileSync(configYamlPath, YAML.stringify(configYaml));
      setConfigFilePermissions(configYamlPath);

      // Open config.yaml
      await openEditorAndRevealRange(
        vscode.Uri.file(configYamlPath),
        undefined,
        undefined,
        false,
      );

      void vscode.window
        .showInformationMessage(
          "Your config.json has been converted to the new config.yaml format. If you need to switch back to config.json, you can delete or rename config.yaml.",
          "Read the docs",
        )
        .then(async (selection) => {
          if (selection === "Read the docs") {
            await vscode.env.openExternal(
              vscode.Uri.parse("https://docs.continue.dev/yaml-migration"),
            );
          }
        });
    },
    "continue.enterEnterpriseLicenseKey": async () => {
      const licenseKey = await vscode.window.showInputBox({
        prompt: "Enter your enterprise license key",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "License key",
      });

      if (!licenseKey) {
        return;
      }

      try {
        const isValid = await core.invoke("mdm/setLicenseKey", {
          licenseKey,
        });

        if (isValid) {
          void vscode.window.showInformationMessage(
            "Enterprise license key successfully validated and saved. Reloading window.",
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else {
          void vscode.window.showErrorMessage(
            "Invalid license key. Please check your license key and try again.",
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to set enterprise license key: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    "continue.toggleNextEditEnabled": async () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const tabAutocompleteEnabled = config.get<boolean>(
        "enableTabAutocomplete",
      );

      if (!tabAutocompleteEnabled) {
        vscode.window.showInformationMessage(
          "Please enable tab autocomplete first to use Next Edit",
        );
        return;
      }

      const nextEditEnabled = config.get<boolean>("enableNextEdit") ?? false;

      // updateNextEditState in VsCodeExtension.ts will handle the validation.
      config.update(
        "enableNextEdit",
        !nextEditEnabled,
        vscode.ConfigurationTarget.Global,
      );
    },
    "continue.openInNewWindow": async (
      options: {
        panelId?: string;
        sessionId?: string;
        title?: string;
        forceNew?: boolean;
        suppressInitialChordCharacter?: boolean;
      } = {},
    ) => {
      if (options.panelId) {
        const existing = fullScreenPanels.get(options.panelId);
        // panelId is only a focus hint from the sidebar. Never let a stale
        // panel id focus a tab whose bound session differs from the clicked
        // row; fall through to the authoritative session lookup instead.
        if (
          existing &&
          (!options.sessionId || existing.sessionId === options.sessionId)
        ) {
          existing.panel.panel.reveal();
          fullScreenPanels.markActive(existing.id);
          return;
        }
      }

      // Navigator clicks focus the already-open tab for that persisted
      // session. The command/chord path has no session id and therefore always
      // creates another independent blank tab.
      if (options.sessionId && !options.forceNew) {
        const existing = fullScreenPanels.forSession(options.sessionId);
        if (existing) {
          existing.panel.panel.reveal();
          fullScreenPanels.markActive(existing.id);
          return;
        }
      }

      let initialSessionId = options.sessionId;
      let initialTitle = options.title;
      if (initialSessionId && !options.forceNew) {
        // Do not create a tab merely to discover that its saved session was
        // deleted/missing. Core.load returns a blank default for that case;
        // saved Cukii sessions are only navigable after their first history
        // entry, so the check is both deterministic and side-effect free.
        let restored;
        try {
          restored = await core.invoke("history/load", {
            id: initialSessionId,
          });
        } catch {
          return;
        }
        if (!restored || restored.history.length === 0) {
          return;
        }
        initialTitle = restored.title;
      }

      const panel = vscode.window.createWebviewPanel(
        FULL_SCREEN_VIEW_TYPE,
        CUKII_BLANK_PANEL_TITLE,
        vscode.ViewColumn.Beside,
        {
          retainContextWhenHidden: true,
          enableScripts: true,
        },
      );

      attachFullScreenPanel(
        panel,
        extensionContext,
        sidebar,
        initialSessionId,
        initialTitle,
        options.suppressInitialChordCharacter,
      );
    },
    "cukii.renameChatPanel": async () => {
      const targets = listCukiiRenameTargets(fullScreenPanels);
      if (targets.length === 0) {
        return;
      }
      // Always require a click in QuickPick. A context-menu invocation on a
      // blank Cukii tab has no session identity either, even when there is
      // only one persisted tab elsewhere in the editor.
      const target = await vscode.window.showQuickPick(
        targets.map((candidate) => ({
          label: candidate.title,
          description: candidate.sessionId,
          detail: "Cukii editor tab",
          panelId: candidate.panelId,
          sessionId: candidate.sessionId,
        })),
        {
          title: "Choose Cukii editor tab to rename",
          placeHolder: "Select the tab you opened the context menu from",
          matchOnDescription: true,
        },
      );
      if (!target) {
        return;
      }
      const entry = getCukiiRenameTarget(target.panelId, fullScreenPanels);
      if (!entry || entry.sessionId !== target.sessionId) {
        return;
      }
      const currentTitle =
        entry.displayTitle?.trim() || entry.panel.panel.title.trim();
      const nextTitle = await vscode.window.showInputBox({
        title: "Rename Cukii session",
        value: currentTitle,
        validateInput: (value) =>
          value.trim() ? undefined : "Title cannot be empty",
      });
      const trimmed = nextTitle?.trim();
      if (!trimmed || trimmed === currentTitle) {
        return;
      }
      const saved = await core.invoke("history/rename", {
        id: entry.sessionId,
        title: trimmed,
      });
      if (!saved) return;
      // A stale Rename command must display the title selected by the CAS
      // boundary if another explicit rename committed first.
      const effectiveTitle = saved.title;
      syncCukiiPanelTitleForSession(entry.sessionId, effectiveTitle);
      entry.panel.protocol.send("cukii/sessionTitleChanged", {
        sessionId: entry.sessionId,
        title: effectiveTitle,
        titleManuallySet: Boolean(saved.titleManuallySet),
      });
      sidebar.webviewProtocol.send(
        "cukii/openChatPanelsChanged",
        listOpenCukiiPanels(),
      );
    },
    "continue.forceNextEdit": async () => {
      // This is basically the same logic as forceAutocomplete.
      // I'm writing a new command KV pair here in case we diverge in features.

      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      await vscode.commands.executeCommand(
        "editor.action.inlineSuggest.trigger",
      );
    },
  };
};

async function installModelWithProgress(
  modelName: string,
  modelInstaller: ModelInstaller,
) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing model '${modelName}'`,
      cancellable: true,
    },
    async (windowProgress, token) => {
      let currentProgress: number = 0;
      const progressWrapper = (
        details: string,
        worked?: number,
        total?: number,
      ) => {
        let increment = 0;
        if (worked && total) {
          const progressValue = Math.round((worked / total) * 100);
          increment = progressValue - currentProgress;
          currentProgress = progressValue;
        }
        windowProgress.report({ message: details, increment });
      };
      const abortController = new AbortController();
      token.onCancellationRequested(() => {
        console.log(`Pulling ${modelName} model was cancelled`);
        abortController.abort();
      });
      await modelInstaller.installModel(
        modelName,
        abortController.signal,
        progressWrapper,
      );
    },
  );
}

export function registerAllCommands(
  context: vscode.ExtensionContext,
  ide: VsCodeIde,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  consoleView: ContinueConsoleWebviewViewProvider,
  configHandler: ConfigHandler,
  verticalDiffManager: VerticalDiffManager,
  battery: Battery,
  quickEdit: QuickEdit,
  core: Core,
  editDecorationManager: EditDecorationManager,
) {
  // До регистрации команд: VS Code отдаёт восстановленные webview сразу после
  // активации, и без сериализатора к этому моменту таб уже осиротел.
  registerFullScreenPanelSerializer(context, extensionContext, sidebar);

  for (const [command, callback] of Object.entries(
    getCommandsMap(
      ide,
      extensionContext,
      sidebar,
      consoleView,
      configHandler,
      verticalDiffManager,
      battery,
      quickEdit,
      core,
      editDecorationManager,
    ),
  )) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback),
    );
  }
}
