import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrokerVendorId } from "core/protocol/ideWebview";

import {
  nativeCliCandidates,
  withOwnerFileLock,
  writeOwnerFileAtomic,
} from "@cukii/vendor-bridge";

export const CUKII_MEMORY_MCP_NAME = "cukii-memory";

export type CukiiMemoryProxyDescriptor = {
  endpoint: string;
  proxyPath: string;
  nodePath: string;
};

export type CukiiMemoryRelayDescriptor = {
  url: string;
  capability: string;
  proxyPath: string;
  nodePath: string;
};

type MemoryMcpOptions = {
  userHome?: string;
  spawn?: typeof spawnSync;
  platform?: NodeJS.Platform;
};

function home(options?: MemoryMcpOptions): string {
  return options?.userHome ?? os.homedir();
}

function managedProxyEnvironment(_descriptor: CukiiMemoryProxyDescriptor) {
  return {
    ELECTRON_RUN_AS_NODE: "1",
    // The endpoint and bearer are injected only into the native vendor process
    // immediately before spawn. Persisting either a random loopback port or a
    // bearer here made the config stale after the VS Code window closed and
    // would leak a long-lived Box credential into owner files.
    CUKII_MEMORY_MANAGED: "2",
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
  return (
    base === "cukiiMemoryProxy.js".toLowerCase() || base === "mcp_proxy.py"
  );
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
    env.CUKII_MEMORY_MANAGED === "2" ||
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

export function memoryMcpEntry(descriptor: CukiiMemoryProxyDescriptor) {
  return {
    command: descriptor.nodePath,
    args: [descriptor.proxyPath],
    env: managedProxyEnvironment(descriptor),
  };
}

function setJsonMemoryServer(
  configPath: string,
  descriptor: CukiiMemoryProxyDescriptor,
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
      ((block.includes("cukiiMemoryProxy.js") &&
        (block.includes("CUKII_MEMORY_MANAGED") ||
          block.includes("CUKII_MEMORY_RELAY_URL"))) ||
        (/^\s*url\s*=\s*["'][^"']+["']\s*$/m.test(block) &&
          /^\s*bearer_token_env_var\s*=\s*["']CUKII_MEMORY_RELAY_TOKEN["']\s*$/m.test(
            block,
          ))),
  );
}

function configureCliVendor(
  vendor: "codex" | "grok",
  descriptor: CukiiMemoryProxyDescriptor,
  addArgs: string[],
  options?: MemoryMcpOptions,
): boolean {
  const configPath = path.join(home(options), `.${vendor}`, "config.toml");
  return withOwnerFileLock(configPath, () => {
    const run = options?.spawn ?? spawnSync;
    // GUI-launched VS Code on macOS does not inherit ~/.local/bin. Use the
    // exact managed/native candidate already shared by install, auth and chat
    // instead of silently failing `codex mcp add` through a bare PATH lookup.
    const platform = options?.platform ?? process.platform;
    const executable =
      platform === "win32"
        ? vendor
        : (nativeCliCandidates(vendor, home(options), platform).find(
            (candidate) =>
              path.isAbsolute(candidate) && fs.existsSync(candidate),
          ) ?? vendor);
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
      const removed = run(executable, removeArgs, {
        timeout: 10_000,
        encoding: "utf8",
      });
      if (removed.status !== 0) return false;
    }
    const added = run(executable, addArgs, {
      timeout: 15_000,
      encoding: "utf8",
    });
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
  descriptor: CukiiMemoryProxyDescriptor,
): string[] {
  return Object.entries(managedProxyEnvironment(descriptor)).flatMap(
    ([key, value]) => ["--env", `${key}=${value}`],
  );
}

function configureCodex(
  descriptor: CukiiMemoryProxyDescriptor,
  options?: MemoryMcpOptions,
): boolean {
  // Codex intentionally filters the environment inherited by stdio MCP
  // children. The Cukii vendor process therefore sees the short-lived Box
  // binding while a bundled proxy spawned below it does not. Let Codex own the
  // HTTPS transport instead: the stable endpoint is non-secret, and the
  // bearer is read from the per-run environment without ever entering TOML.
  return configureCliVendor(
    "codex",
    descriptor,
    [
      "mcp",
      "add",
      CUKII_MEMORY_MCP_NAME,
      "--url",
      descriptor.endpoint,
      "--bearer-token-env-var",
      "CUKII_MEMORY_RELAY_TOKEN",
    ],
    options,
  );
}

function configureGrok(
  descriptor: CukiiMemoryProxyDescriptor,
  options?: MemoryMcpOptions,
): boolean {
  const envArgs = Object.entries(managedProxyEnvironment(descriptor)).flatMap(
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
  descriptor: CukiiMemoryProxyDescriptor,
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
