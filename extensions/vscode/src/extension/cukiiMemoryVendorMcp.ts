import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrokerVendorId } from "core/protocol/ideWebview";

import {
  withOwnerFileLock,
  writeOwnerFileAtomic,
} from "./ownerFileTransaction";

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

function relayEnvironment(descriptor: CukiiMemoryRelayDescriptor) {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    CUKII_MEMORY_MANAGED: "1",
    CUKII_MEMORY_RELAY_URL: descriptor.url,
    CUKII_MEMORY_RELAY_TOKEN: descriptor.capability,
  };
}

function stringParts(entry: { command?: unknown; args?: unknown }): string[] {
  const command = typeof entry.command === "string" ? [entry.command] : [];
  const args = Array.isArray(entry.args) ? entry.args : [];
  return [...command, ...args].filter(
    (item): item is string => typeof item === "string",
  );
}

function isCukiiMemoryProxyPath(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  return base === "cukiiMemoryProxy.js".toLowerCase() || base === "mcp_proxy.py";
}

function isManagedJsonEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as {
    command?: unknown;
    args?: unknown;
    env?: Record<string, unknown>;
  };
  const env = entry.env ?? {};
  const hasProxy = stringParts(entry).some(isCukiiMemoryProxyPath);
  const hasManagedEnv =
    env.CUKII_MEMORY_MANAGED === "1" ||
    typeof env.CUKII_MEMORY_RELAY_URL === "string" ||
    typeof env.AGENT_HUB_MEMORY_URL === "string";
  return hasProxy && hasManagedEnv;
}

function readJsonOwnerConfig(configPath: string): {
  mcpServers?: Record<string, unknown>;
} {
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("owner MCP config is not a JSON object");
  }
  return parsed as { mcpServers?: Record<string, unknown> };
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
  withOwnerFileLock(configPath, () => {
    const config = readJsonOwnerConfig(configPath);
    if (
      config.mcpServers !== undefined &&
      (typeof config.mcpServers !== "object" ||
        config.mcpServers === null ||
        Array.isArray(config.mcpServers))
    ) {
      throw new Error("owner MCP servers config is not an object");
    }
    const existing = config.mcpServers?.[CUKII_MEMORY_MCP_NAME];
    if (existing && !isManagedJsonEntry(existing)) {
      throw new Error("owner already defines cukii-memory");
    }
    config.mcpServers = {
      ...(config.mcpServers ?? {}),
      [CUKII_MEMORY_MCP_NAME]: {
        ...memoryMcpEntry(descriptor),
        ...(options.trust === undefined ? {} : { trust: options.trust }),
      },
    };
    writeOwnerFileAtomic(configPath, JSON.stringify(config, null, 2));
  });
}

function removeJsonMemoryServer(configPath: string): void {
  try {
    withOwnerFileLock(configPath, () => {
      const config = readJsonOwnerConfig(configPath);
      const servers = config.mcpServers;
      const existing = servers?.[CUKII_MEMORY_MCP_NAME];
      if (!existing || !isManagedJsonEntry(existing)) return;
      delete servers[CUKII_MEMORY_MCP_NAME];
      writeOwnerFileAtomic(configPath, JSON.stringify(config, null, 2));
    });
  } catch {
    // A missing or owner-managed unreadable config is left untouched.
  }
}

function tomlMemoryBlock(body: string): string | undefined {
  const start = body.search(/^\s*\[mcp_servers\.cukii-memory\]\s*$/m);
  if (start < 0) return undefined;
  const tail = body.slice(start);
  const next = tail
    .slice(1)
    .search(/^\s*\[mcp_servers\.(?!cukii-memory(?:\.env)?\])[^\]]+\]\s*$/m);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function isManagedTomlConfig(body: string): boolean {
  const block = tomlMemoryBlock(body);
  return Boolean(
    block &&
      block.includes("cukiiMemoryProxy.js") &&
      (block.includes("CUKII_MEMORY_MANAGED") ||
        block.includes("CUKII_MEMORY_RELAY_URL")),
  );
}

function configureCliVendor(
  vendor: "codex" | "grok",
  descriptor: CukiiMemoryRelayDescriptor,
  addArgs: string[],
  options?: MemoryMcpOptions,
): boolean {
  const configPath = path.join(home(options), `.${vendor}`, "config.toml");
  return withOwnerFileLock(configPath, () => {
    const run = options?.spawn ?? spawnSync;
    const before = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : undefined;
    const existing = before === undefined ? undefined : tomlMemoryBlock(before);
    if (existing && !isManagedTomlConfig(before!)) return false;
    const removeArgs =
      vendor === "codex"
        ? ["mcp", "remove", CUKII_MEMORY_MCP_NAME]
        : ["mcp", "remove", "-s", "user", CUKII_MEMORY_MCP_NAME];
    if (existing) {
      const removed = run(vendor, removeArgs, {
        timeout: 10_000,
        encoding: "utf8",
      });
      if (removed.status !== 0) return false;
    }
    const added = run(vendor, addArgs, { timeout: 15_000, encoding: "utf8" });
    if (added.status !== 0) {
      if (before !== undefined) {
        writeOwnerFileAtomic(configPath, before);
      } else {
        try {
          const created = fs.readFileSync(configPath, "utf8");
          if (isManagedTomlConfig(created)) fs.unlinkSync(configPath);
        } catch {
          // No prior owner file existed; leave only unknown, non-managed data.
        }
      }
      return false;
    }
    try {
      fs.chmodSync(configPath, 0o600);
    } catch {
      // Windows ACLs are authoritative.
    }
    return true;
  });
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
  return configureCliVendor(
    "codex",
    descriptor,
    [
      "mcp",
      "add",
      CUKII_MEMORY_MCP_NAME,
      ...commandEnvironmentArgs(descriptor),
      "--",
      descriptor.nodePath,
      descriptor.proxyPath,
    ],
    options,
  );
}

function configureGrok(
  descriptor: CukiiMemoryRelayDescriptor,
  options?: MemoryMcpOptions,
): boolean {
  const envArgs = Object.entries(relayEnvironment(descriptor)).flatMap(
    ([key, value]) => ["-e", `${key}=${value}`],
  );
  return configureCliVendor(
    "grok",
    descriptor,
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
    options,
  );
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
    const configPath = path.join(root, `.${vendor}`, "config.toml");
    let body = "";
    try {
      body = fs.readFileSync(configPath, "utf8");
    } catch {
      return;
    }
    if (!isManagedTomlConfig(body)) return;
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
