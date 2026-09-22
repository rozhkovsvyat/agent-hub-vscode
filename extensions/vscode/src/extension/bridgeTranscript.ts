// Extracted to packages/vendor-bridge (phase 1); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  MAX_BRIDGE_TRANSCRIPT_CHARS,
  bridgeTranscriptCharLimit,
  contentToText,
  buildBridgeTranscript,
} from "@cukii/vendor-bridge";
