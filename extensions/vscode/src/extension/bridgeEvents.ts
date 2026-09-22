// Extracted to packages/vendor-bridge (phase 1); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  usageWindowsFromEvent,
  visibleKimiAssistantText,
  BridgeEventParser,
} from "@cukii/vendor-bridge";
export type { BridgeEvent, BridgeFormat } from "@cukii/vendor-bridge";
