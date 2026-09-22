// Extracted to packages/vendor-bridge (phase 1); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  MAX_GROK_PROMPT_JSON_BYTES,
  grokImageBlock,
  grokPromptJson,
  describeBridgeLaunch,
} from "@cukii/vendor-bridge";
export type { GrokPromptBlock } from "@cukii/vendor-bridge";
