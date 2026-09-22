// Extracted to packages/vendor-bridge (phase 1); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  parseSupportedVisionDataUrl,
  bridgeAttachmentDir,
  BridgeImageScope,
  hasImageAttachment,
  selectBridgeImageSources,
  materializeBridgeImages,
  materializeBridgeMessageContent,
} from "@cukii/vendor-bridge";
export type {
  ParsedVisionDataUrl,
  BridgeInboxImageReference,
} from "@cukii/vendor-bridge";
