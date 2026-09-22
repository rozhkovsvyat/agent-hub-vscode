// Extracted to packages/vendor-bridge (phase 1); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  bridgeInboxRoot,
  writeBridgeInboxMessageWithReceipt,
  writeBridgeInboxMessage,
  bridgeInboxMessageStatus,
  markBridgeInboxMessagesRead,
  purgeUnreadBridgeInboxMessages,
  readBridgeInboxMessageIds,
  BridgeInboxWatch,
} from "@cukii/vendor-bridge";
export type {
  BridgeInboxStatus,
  BridgeInboxWriteMetadata,
  BridgeInboxWriteReceipt,
} from "@cukii/vendor-bridge";
