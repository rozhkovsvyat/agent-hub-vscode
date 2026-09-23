// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  bridgeBindingRoot,
  lineageHasValidStartOrder,
  processLineage,
  readRunBindingForPid,
  registerRunBinding,
  resolveAncestorRunBinding,
  resolveRunBindingFromLineage,
} from "@cukii/vendor-bridge";
export type {
  CukiiRunBinding,
  ProcessSnapshot,
} from "@cukii/vendor-bridge";
