// Extracted to packages/vendor-bridge (phase 2); kept as a re-export shim so
// existing plugin imports keep working with zero behaviour change.
export {
  fetchesPackageOnStart,
  parseDisabledGrokMcpServers,
  parseGrokTomlMcpServers,
  parseClaudeCompatMcpServers,
  collectGrokMcpServers,
  unresolvableGrokMcpServers,
  canSpawnCommand,
  grokMcpPreflightAdvice,
  grokMcpStallAdvice,
  describeGrokMcpFaults,
} from "@cukii/vendor-bridge";
export type {
  GrokMcpServer,
  CommandResolver,
  GrokMcpFaults,
} from "@cukii/vendor-bridge";
