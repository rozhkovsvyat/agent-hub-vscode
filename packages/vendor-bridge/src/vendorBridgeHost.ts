/**
 * Host port for the vendor bridge library. The library is vscode-free; the
 * two host facts it genuinely needs (the workspace cwd and the installed
 * extension identity used by the runtime canary) are supplied by the host
 * through this binding. The default is deliberately inert: no workspace and
 * no extension identity, so the canary simply stays off.
 */
export interface VendorBridgeExtensionInfo {
  extensionPath: string;
  version: string;
}

export interface VendorBridgeHostContext {
  /** Absolute path of the host's primary workspace folder, if any. */
  workspaceCwd(): string | undefined;
  /** Identity of the installed host extension, if it can be resolved. */
  extensionInfo(): VendorBridgeExtensionInfo | undefined;
}

let vendorBridgeHost: VendorBridgeHostContext = {
  workspaceCwd: () => undefined,
  extensionInfo: () => undefined,
};

export function configureVendorBridgeHost(host: VendorBridgeHostContext): void {
  vendorBridgeHost = host;
}

export function vendorBridgeHostCwd(): string | undefined {
  return vendorBridgeHost.workspaceCwd();
}

export function vendorBridgeHostExtensionInfo():
  | VendorBridgeExtensionInfo
  | undefined {
  return vendorBridgeHost.extensionInfo();
}
