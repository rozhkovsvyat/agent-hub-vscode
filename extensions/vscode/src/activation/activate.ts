import { getContinueRcPath } from "core/util/paths";
import * as vscode from "vscode";

import { VsCodeExtension } from "../extension/VsCodeExtension";
import { startYougileIssueOutbox } from "../extension/yougileIssueReporterVscode";
import { isUnsupportedPlatform } from "../util/util";

import { GlobalContext } from "core/util/GlobalContext";
import { VsCodeContinueApi } from "./api";
import setupInlineTips from "./InlineTipManager";

let activeExtension: VsCodeExtension | undefined;

export async function activateExtension(context: vscode.ExtensionContext) {
  const platformCheck = isUnsupportedPlatform();
  const globalContext = new GlobalContext();
  const hasShownUnsupportedPlatformWarning = globalContext.get(
    "hasShownUnsupportedPlatformWarning",
  );

  if (platformCheck.isUnsupported && !hasShownUnsupportedPlatformWarning) {
    const platformTarget = "windows-arm64";

    globalContext.update("hasShownUnsupportedPlatformWarning", true);
    void vscode.window.showInformationMessage(
      `Continue detected that you are using ${platformTarget}. Due to native dependencies, Continue may not be able to start`,
    );
  }

  // 🔴 Only the files Cukii itself uses. `tsconfig.json` exists solely for the
  // deprecated `config.ts` API, which Cukii never loads; scaffolding it left an
  // orphan in ~/.continue that helper agents then asked the owner about during
  // a fresh install. `getConfigTsPath()` is deliberately not called here for
  // the same reason — it would write config.ts, package.json and types/core.
  getContinueRcPath();

  // Register commands and providers
  setupInlineTips(context);

  const vscodeExtension = new VsCodeExtension(context);
  activeExtension = vscodeExtension;
  // A report survives extension/window restarts in globalStorage. Start the
  // single delivery worker at activation rather than waiting for the chat
  // webview to be opened again.
  context.subscriptions.push(startYougileIssueOutbox(context));

  // Load Continue configuration
  if (!context.globalState.get("hasBeenInstalled")) {
    void context.globalState.update("hasBeenInstalled", true);
  }

  // 🔴 No global-settings side effect. Registering the schema rewrote the
  // owner's user settings.json with a versioned extension path on every
  // install, leaving stale `yaml.schemas` entries that look like leftovers and
  // invited questions about configuring models by hand. Cukii's models are
  // chosen in its own picker, so the editor-side schema hint is not worth
  // mutating user settings for.

  const api = new VsCodeContinueApi(vscodeExtension);
  const continuePublicApi = {
    registerCustomContextProvider: api.registerCustomContextProvider.bind(api),
  };

  // 'export' public api-surface
  // or entire extension for testing
  return process.env.NODE_ENV === "test"
    ? {
        ...continuePublicApi,
        extension: vscodeExtension,
      }
    : continuePublicApi;
}

export async function deactivateExtension(): Promise<void> {
  await activeExtension?.shutdown();
  activeExtension = undefined;
}
