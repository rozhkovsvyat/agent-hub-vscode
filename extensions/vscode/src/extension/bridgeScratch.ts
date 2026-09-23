// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change. The eager
// constants are computed here, after the host storage configuration lands.
import "./vendorBridgeHost";
import {
  bridgeScratchRootPath,
  permissionScratchRootPath,
  voiceScratchRootPath,
} from "@cukii/vendor-bridge";

export const CUKII_BRIDGE_SCRATCH_ROOT = bridgeScratchRootPath();
export const CUKII_PERMISSION_SCRATCH_ROOT = permissionScratchRootPath();
export const CUKII_VOICE_SCRATCH_ROOT = voiceScratchRootPath();

export {
  windowsScratchBase,
  createDirectoryWithoutReparse,
  bridgeScratchRoot,
  permissionScratchRoot,
  voiceScratchRoot,
  createCukiiScratchDirectory,
  removeCukiiScratchDirectory,
  writeBridgeScratchFile,
  removeBridgeScratchFile,
  createBridgeScratchPath,
  bridgeScratchRootPath,
  permissionScratchRootPath,
  voiceScratchRootPath,
} from "@cukii/vendor-bridge";
