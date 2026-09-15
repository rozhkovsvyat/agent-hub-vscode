import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrokerVendorId } from "core/protocol/ideWebview";

export const CUKII_MEMORY_MCP_NAME = "cukii-memory";

export type CukiiMemoryRelayDescriptor = {
  url: string;
  capability: string;
  proxyPath: string;
  nodePath: string;
};

type MemoryMcpOptions = {
  userHome?: string;
  spawn?: typeof spawnSync;
};

function home(options?: MemoryMcpOptions): string {
  return options?.userHome ?? os.homedir();
}

function writeAtomic(target: string, body: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.cukii-memory.tmp`;
  fs.writeFileSync(tmp, body, { encoding: "utf8" });
  fs.renameSync(tmp, target);
}

function relayEnvironment(descriptor: CukiiMemoryRelayDescriptor) {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    CUKII_MEMORY_RELAY_URL: descriptor.url,
    CUKII_MEMORY_RELAY_TOKEN: descriptor.capability,
  };
}

export function memoryMcpEntry(descriptor: CukiiMemoryRelayDescriptor) {
  return {
    command: descriptor.nodePath,
    args: [descriptor.proxyPath],
    env: relayEnvironment(descriptor),
  };
}

function setJsonMemoryServer(
  configPath: string,
  descriptor: CukiiMemoryRelayDescriptor,
  options: { trust?: boolean } = {},
): void {
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof config;
  } catch {
    config = {};
  }
  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    [CUKII_MEMORY_MCP_NAME]: {
      ...memoryMcpEntry(descriptor),
      ...(options.trust === undefined ? {} : { trust: options.trust }),
    },
  };
  writeAtomic(configPath, JSON.stringify(config, null, 2));
}

function removeJsonMemoryServer(configPath: string): void {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    if (!config.mcpServers?.[CUKII_MEMORY_MCP_NAME]) return;
    delete config.mcpServers[CUKII_MEMORY_MCP_NAME];
    writeAtomic(configPath, JSON.stringify(config, null, 2));
  } catch {
    // A missing or owner-managed unreadable config is left untouched.
  }
}

function commandEnvironmentArgs(
  descriptor: CukiiMemoryRelayDescriptor,
): string[] {
  return Object.entries(relayEnvironment(descriptor)).flatMap(
    ([key, value]) => ["--env", `${key}=${value}`],
  );
}

function configureCodex(
  descriptor: CukiiMemoryRelayDescriptor,
  options?: MemoryMcpOptions,
): boolean {
  const run = options?.spawn ?? spawnSync;
  run("codex", ["mcp", "remove", CUKII_MEMORY_MCP_NAME], {
    timeout: 10_000,
    encoding: "utf8",
  });
  const result = run(
    "codex",
    [
      "mcp",
      "add",
      CUKII_MEMORY_MCP_NAME,
      ...commandEnvironmentArgs(descriptor),
      "--",
      descriptor.nodePath,
      descriptor.proxyPath,
    ],
    { timeout: 15_000, encoding: "utf8" },
  );
  return result.status === 0;
}

function configureGrok(
  descriptor: CukiiMemoryRelayDescriptor,
  options?: MemoryMcpOptions,
): boolean {
  const run = options?.spawn ?? spawnSync;
  run("grok", ["mcp", "remove", "-s", "user", CUKII_MEMORY_MCP_NAME], {
    timeout: 10_000,
    encoding: "utf8",
  });
  const envArgs = Object.entries(relayEnvironment(descriptor)).flatMap(
    ([key, value]) => ["-e", `${key}=${value}`],
  );
  const result = run(
    "grok",
    [
      "mcp",
      "add",
      "--scope",
      "user",
      ...envArgs,
      CUKII_MEMORY_MCP_NAME,
      descriptor.nodePath,
      descriptor.proxyPath,
    ],
    { timeout: 15_000, encoding: "utf8" },
  );
  return result.status === 0;
}

export function ensureCukiiMemoryVendorMcp(
  vendor: BrokerVendorId,
  descriptor: CukiiMemoryRelayDescriptor,
  options?: MemoryMcpOptions,
): boolean {
  try {
    const root = home(options);
    switch (vendor) {
      case "claude":
        setJsonMemoryServer(path.join(root, ".claude.json"), descriptor);
        return true;
      case "qwen":
        setJsonMemoryServer(
          path.join(root, ".qwen", "settings.json"),
          descriptor,
          { trust: false },
        );
        return true;
      case "cursor":
        setJsonMemoryServer(path.join(root, ".cursor", "mcp.json"), descriptor);
        return true;
      case "kimi":
        setJsonMemoryServer(
          path.join(root, ".kimi-code", "mcp.json"),
          descriptor,
        );
        return true;
      case "codex":
        return configureCodex(descriptor, options);
      case "grok":
        return configureGrok(descriptor, options);
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export function removeCukiiMemoryVendorMcp(
  vendor: BrokerVendorId,
  options?: MemoryMcpOptions,
): void {
  const root = home(options);
  if (vendor === "codex" || vendor === "grok") {
    const run = options?.spawn ?? spawnSync;
    const args =
      vendor === "codex"
        ? ["mcp", "remove", CUKII_MEMORY_MCP_NAME]
        : ["mcp", "remove", "-s", "user", CUKII_MEMORY_MCP_NAME];
    try {
      run(vendor, args, { timeout: 10_000, encoding: "utf8" });
    } catch {
      // Disconnect is best-effort; the stopped relay makes stale entries inert.
    }
    return;
  }
  const paths: Partial<Record<BrokerVendorId, string>> = {
    claude: path.join(root, ".claude.json"),
    qwen: path.join(root, ".qwen", "settings.json"),
    cursor: path.join(root, ".cursor", "mcp.json"),
    kimi: path.join(root, ".kimi-code", "mcp.json"),
  };
  const configPath = paths[vendor];
  if (configPath) removeJsonMemoryServer(configPath);
}
