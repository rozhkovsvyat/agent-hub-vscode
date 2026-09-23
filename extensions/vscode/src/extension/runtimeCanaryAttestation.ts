// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  runtimeCanaryTurn,
  RuntimeCanaryAttestation,
  runtimeCanaryExtensionBinding,
  runtimeCanaryResult,
  runtimeCanaryResponseSummary,
} from "@cukii/vendor-bridge";
export type {
  RuntimeCanaryTurn,
  RuntimeCanaryEventName,
  RuntimeCanaryResult,
  RuntimeCanaryExtensionBinding,
  RuntimeCanaryEvent,
  RuntimeCanaryReporter,
} from "@cukii/vendor-bridge";
