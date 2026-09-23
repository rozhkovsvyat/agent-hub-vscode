// Extracted to packages/vendor-bridge (phase 2). This file stays as the
// esbuild entry point so out/claudePermissionMcpWorker.js keeps its name and
// self-executes exactly like before.
import { startMcpStdio } from "@cukii/vendor-bridge";

if (require.main === module) startMcpStdio();
