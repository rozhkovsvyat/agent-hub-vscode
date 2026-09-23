// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change. The host
// side-effect import pins the owner's storage volumes before any call.
import "./vendorBridgeHost";

export {
  configureBridgeStorageHost,
  resolveWindowsScratchRoot,
  removeCaseInsensitiveEnvKeys,
  resolveBridgeStorageLayout,
  bridgeStorageEnvOverrides,
  bridgeStorageProcessEnv,
} from "@cukii/vendor-bridge";
export type {
  BridgeStorageLayout,
  BridgeStorageOptions,
  BridgeStorageHostConfig,
} from "@cukii/vendor-bridge";
