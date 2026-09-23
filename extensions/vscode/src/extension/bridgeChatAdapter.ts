// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change. The host
// side-effect import wires the workspace cwd and extension identity into the
// library before any stream/route call happens.
import "./vendorBridgeHost";

export {
  BROKER_PROMPT_PREAMBLE,
  isOwnPromptEcho,
  queuedFollowUpEchoMessageId,
  attachClaudePermissionTransport,
  KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16,
  isKimiModel,
  nativeResumeIdForModel,
  windowsCommandLineUtf16Length,
  BROKER_NOT_ROUTABLE_GUIDANCE,
  bridgeResumeUserText,
  isClaudeNativeModel,
  supportsBrokerInbox,
  brokerMemoryDirective,
  brokerInboxDirective,
  brokerUserQuestionDirective,
  nativeDelegateHint,
  nativePromptCacheArgs,
  claudeStreamingInput,
  claudeInitialContent,
  grokBridgeEnv,
  routeForModel,
  isBridgeTerminalChatMessage,
  bridgeEventsProveInputAccepted,
  bridgeProcessExitIsFailure,
  bridgeProcessFailureTerminalEvent,
  readableFailureReason,
  bridgeProcessFailureMessage,
  bridgeFailureDetail,
  settleBridgeChildError,
  toChatMessages,
  streamBridgeChat,
} from "@cukii/vendor-bridge";
// bridgeChatAdapter's own commandCandidates, disambiguated from the
// permissionCapabilities one inside the package index.
export { bridgeRouteCommandCandidates as commandCandidates } from "@cukii/vendor-bridge";
export type {
  BridgeRoute,
  ClaudePermissionTransport,
  CukiiBridgeWait,
  CukiiBridgeChatMessage,
  BridgeChildErrorSettlement,
} from "@cukii/vendor-bridge";
