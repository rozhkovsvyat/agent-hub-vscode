// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  ALIBABA_SECRET_KEY,
  bindAlibabaSecretStore,
  alibabaSettingsPath,
  looksLikeAlibabaTokenPlanKey,
  extractAlibabaTokenPlanKey,
  redactAlibabaSecrets,
  stripAlibabaCredentialConfig,
  tokenPlanSettingsWithoutSecrets,
  readAlibabaCredential,
  storeAlibabaCredential,
  clearAlibabaCredential,
  migratePlaintextAlibabaSettings,
  alibabaIdentity,
  alibabaSpawnEnv,
  alibabaQwenArgv,
  loginAlibabaTokenPlan,
  logoutAlibabaTokenPlan,
  runAlibabaAuthAction,
  settingsContainAlibabaSecret,
} from "@cukii/vendor-bridge";
export type {
  ProtectedSecretStore,
  AlibabaAuthHost,
  AlibabaAuthPoll,
} from "@cukii/vendor-bridge";
