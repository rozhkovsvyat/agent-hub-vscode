// The worker implementation lives in the @cukii/vendor-bridge dependency.
// This file stays as the esbuild entry point so out/claudePermissionMcpWorker.js
// keeps its name and self-executes exactly like before.
import { startMcpStdio } from "@cukii/vendor-bridge";

if (require.main === module) startMcpStdio();
