// Host configuration for @cukii/vendor-bridge. Imported for side effects by
// the extension modules whose consumers rely on the host values being set:
// the owner's rotation-managed storage volumes and the VS Code host facts
// (workspace cwd, extension identity for the runtime canary). The library
// defaults are machine-free; this module is where the machine speaks up.
//
// vscode is required lazily: vitest suites load this module through the
// importers without a vscode mock, and a top-level `import * as vscode` would
// fail their module graph outright. A suite that does mock vscode still gets
// the mock.
type VscodeApi = typeof import("vscode");

function vscodeApi(): VscodeApi | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("vscode") as VscodeApi;
  } catch {
    return undefined;
  }
}

import {
  configureBridgeStorageHost,
  configureVendorBridgeHost,
} from "@cukii/vendor-bridge";

configureBridgeStorageHost({
  preferredWindowsScratchRoot: "D:\\Scratch",
  preferredWindowsPnpmStoreRoot: "D:\\PnpmStore",
  forbiddenWindowsRoots: [
    "d:\\tmp",
    "d:\\brain\\tmp",
    "d:\\brain\\worktrees",
    "d:\\brain\\pnpm-store",
    "d:\\.pnpm-store",
  ],
});

configureVendorBridgeHost({
  workspaceCwd: () => vscodeApi()?.workspace.workspaceFolders?.[0]?.uri.fsPath,
  extensionInfo: () => {
    const extension = vscodeApi()?.extensions?.getExtension(
      "cukii.cukii-vscode",
    );
    if (!extension) return undefined;
    return {
      extensionPath: extension.extensionPath,
      version: String(extension.packageJSON.version),
    };
  },
});

// The historical eager scratch constants of the plugin. The library exposes
// lazy path functions (bridgeScratchRootPath and friends); here they are
// resolved after the host storage configuration above has landed, preserving
// the old import-time semantics for the remaining plugin consumers.
import {
  bridgeScratchRootPath,
  permissionScratchRootPath,
  voiceScratchRootPath,
} from "@cukii/vendor-bridge";

export const CUKII_BRIDGE_SCRATCH_ROOT = bridgeScratchRootPath();
export const CUKII_PERMISSION_SCRATCH_ROOT = permissionScratchRootPath();
export const CUKII_VOICE_SCRATCH_ROOT = voiceScratchRootPath();
