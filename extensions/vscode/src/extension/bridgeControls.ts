// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  resolveBridgeControls,
  bridgeControlPrompt,
  bridgeControlSummary,
  claudeControlArgs,
  codexControlArgs,
  grokControlArgs,
  cursorModelId,
  permissionControlArgs,
} from "@cukii/vendor-bridge";
export type {
  BridgeControlResolution,
} from "@cukii/vendor-bridge";
