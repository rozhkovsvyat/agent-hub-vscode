// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  resolveCodexHome,
  ensureCodexModelsCacheCompatible,
  isCodexModelsCacheFailure,
} from "@cukii/vendor-bridge";
export type {
  CodexCacheHealOutcome,
} from "@cukii/vendor-bridge";
