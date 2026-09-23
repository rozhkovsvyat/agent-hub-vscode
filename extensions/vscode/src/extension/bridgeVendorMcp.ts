// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  BROKER_MCP_NAME,
  QUESTION_MCP_NAME,
  resolveBrokerDir,
  brokerPythonCommand,
  registerBrokerSessionBinding,
  ensureQwenBrokerRegistration,
  ensureCursorBrokerRegistration,
  ensureClaudeBrokerRegistration,
  ensureCodexBrokerRegistration,
  ensureGrokBrokerRegistration,
  ensureKimiBrokerRegistration,
  ensureBrokerVendorIntegration,
  resetBrokerIntegrationMemoForTests,
} from "@cukii/vendor-bridge";
export type {
  BrokerIntegrationOptions,
} from "@cukii/vendor-bridge";
