import fs from "node:fs";

import { ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT } from "core/cukiiAlibabaCatalog";
import {
  bridgeStorageEnvOverrides,
  resolveBridgeStorageLayout,
  type BridgeStorageOptions,
} from "./bridgeStorageEnv";

export interface BridgeTerminalLaunchSpec {
  program: string;
  args: string[];
  cwd: string;
  env: Record<string, string | null>;
}

/**
 * Returns the native CLI command for an interactive bridge terminal.
 *
 * Cursor names its supported Windows binary `agent`, while macOS/Linux use
 * `cursor-agent`. Keeping this decision here prevents the UI route from
 * accidentally falling back to a WSL-only wrapper.
 */
export function bridgeTerminalLaunchSpec(
  agent: string,
  root: string,
  bridgeSessionId: string,
  role: string,
  scope: string,
  platform: NodeJS.Platform = process.platform,
  storageOptions: BridgeStorageOptions & {
    ensureDirectory?: (candidate: string) => void;
  } = {},
): BridgeTerminalLaunchSpec {
  const program =
    agent === "cursor"
      ? platform === "win32"
        ? "agent"
        : "cursor-agent"
      : agent;

  const args =
    agent === "codex"
      ? ["--cd", root]
      : agent === "grok"
        ? ["--cwd", root]
        : agent === "qwen"
          ? ["--model", "qwen3.8-max"]
          : [];

  const storageOptionsForPlatform = { ...storageOptions, platform };
  if (platform === "win32") {
    const storage = resolveBridgeStorageLayout(storageOptionsForPlatform);
    (storageOptions.ensureDirectory ?? ((candidate) => fs.mkdirSync(candidate, { recursive: true })))(
      storage.tempDir,
    );
  }

  return {
    program,
    args,
    cwd: root,
    env: {
      ...bridgeStorageEnvOverrides(storageOptionsForPlatform),
      AGENT_HUB_BRIDGE_SESSION: bridgeSessionId,
      AGENT_HUB_BRIDGE_ROLE: role,
      AGENT_HUB_BRIDGE_SCOPE: scope,
      ...(agent === "qwen"
        ? { OPENAI_BASE_URL: ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT }
        : {}),
    },
  };
}
