// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  setBrokerStatusPollerForTests,
  isDelegationTool,
  isAllowedLogPath,
  parseNestedWorker,
  createLogTailer,
  createNestedWorkerFollower,
  drainFollowers,
  closeFollowers,
  registerNestedWorkerFollower,
} from "@cukii/vendor-bridge";
export type {
  BrokerStatusPoller,
  NestedWorkerTarget,
  LogTailer,
  NestedWorkerFollower,
} from "@cukii/vendor-bridge";
