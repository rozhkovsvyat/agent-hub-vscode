import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrokerModel } from "core/protocol/ideWebview";
import { brokerVendorForModel } from "core/cukiiPermissionModes";

/**
 * Idempotent vendor-side wiring for the broker inbox channel. The inbox
 * itself lives in `~/.continue/cukii-inbox`; what each vendor needs is
 * (1) the cukii-broker MCP server registered so `broker_inbox` /
 * `broker_send` are callable mid-run, and (2) the strict PreToolUse gate
 * hook that force-delivers messages which outlived their grace window.
 * Every function is fail-open: a registration problem must never block the
 * run — the turn-end drain fallback still delivers queued messages.
 *
 * Claude is deliberately not wired: its stdin channel interrupts the turn
 * live, which is a stronger guarantee than the gate.
 */

export const BROKER_MCP_NAME = "cukii-broker";
const GATE_MARKER = "inbox_gate.py";
const MANAGED_MARKER = "# cukii-inbox-channel (managed by the Cukii plugin)";
const GROK_HOOK_FILENAME = "cukii-inbox.json";

export interface BrokerIntegrationOptions {
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to node's spawnSync (grok MCP only). */
  spawn?: typeof spawnSync;
}

interface VendorRegistration {
  mcpAdded: boolean;
  hookAdded: boolean;
  /** Why nothing was done, when applicable. */
  skipped?: string;
}

const completed = new Set<string>();

function home(options?: BrokerIntegrationOptions): string {
  return options?.userHome ?? os.homedir();
}

function envOf(options?: BrokerIntegrationOptions): NodeJS.ProcessEnv {
  return options?.env ?? process.env;
}

/**
 * The broker package is discovered, never hardcoded: explicit env override,
 * else the existing qwen registration (the R1 install path on this class of
 * machines). Returns undefined when nothing resolves — all registrations
 * then no-op and the drain fallback carries the guarantee alone.
 */
export function resolveBrokerDir(
  options?: BrokerIntegrationOptions,
): string | undefined {
  const env = envOf(options);
  const candidates: string[] = [];
  const fromEnv = env.CUKII_BROKER_DIR;
  if (fromEnv) candidates.push(fromEnv);
  const qwenSettings = path.join(home(options), ".qwen", "settings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(qwenSettings, "utf8")) as {
      mcpServers?: Record<string, { args?: unknown }>;
    };
    const args = parsed?.mcpServers?.[BROKER_MCP_NAME]?.args;
    if (Array.isArray(args)) {
      const script = args.find(
        (arg): arg is string =>
          typeof arg === "string" && arg.endsWith("mcp_server.py"),
      );
      if (script) candidates.push(path.dirname(script));
    }
  } catch {
    // Missing or torn config: discovery simply yields no candidate.
  }
  for (const dir of candidates) {
    try {
      if (
        fs.existsSync(path.join(dir, "mcp_server.py")) &&
        fs.existsSync(path.join(dir, "hooks", GATE_MARKER))
      ) {
        return dir;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function brokerPythonCommand(
  options?: BrokerIntegrationOptions,
): string {
  return (
    envOf(options).CUKII_BROKER_PYTHON ||
    (process.platform === "win32" ? "python" : "python3")
  );
}

/**
 * Bind one live vendor root to its Cukii session in broker-owned storage.
 * Static MCP launchers are allowed to replace their child environment, so
 * the Python broker validates this file against the OS process start token
 * instead of trusting inherited env/argv. Failure is fail-open because the
 * same pending batch is embedded directly into the next vendor prompt.
 */
export function registerBrokerSessionBinding(
  vendorPid: number,
  sessionId: string,
  messageIds: string[] = [],
  options?: BrokerIntegrationOptions,
): boolean {
  if (!Number.isSafeInteger(vendorPid) || vendorPid <= 0 || !sessionId) {
    return false;
  }
  const brokerDir = resolveBrokerDir(options);
  if (!brokerDir) return false;
  try {
    const spawnFn = options?.spawn ?? spawnSync;
    const result = spawnFn(
      brokerPythonCommand(options),
      [
        path.join(brokerDir, "session_identity.py"),
        "--register",
        String(vendorPid),
        sessionId,
        ...messageIds.flatMap((messageId) => ["--message-id", messageId]),
      ],
      {
        timeout: 5000,
        encoding: "utf8",
        env: envOf(options),
      },
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function writeAtomic(target: string, body: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: "utf8" });
  fs.renameSync(tmp, target);
}

function mcpEntry(brokerDir: string, options?: BrokerIntegrationOptions) {
  return {
    command: brokerPythonCommand(options),
    args: [path.join(brokerDir, "mcp_server.py")],
    env: { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  };
}

function gateCommand(
  brokerDir: string,
  harness: string,
  options?: BrokerIntegrationOptions,
): string {
  const gate = path.join(brokerDir, "hooks", GATE_MARKER);
  return `${brokerPythonCommand(options)} "${gate}" -Harness ${harness}`;
}

/** qwen: settings.json carries both mcpServers and hooks (JSON-safe edit). */
export function ensureQwenBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const settingsPath = path.join(home(options), ".qwen", "settings.json");
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {
      mcpAdded: false,
      hookAdded: false,
      skipped: "qwen settings unreadable",
    };
  }
  let mcpAdded = false;
  let hookAdded = false;
  const serialized = JSON.stringify(settings);
  const mcpServers =
    typeof settings.mcpServers === "object" && settings.mcpServers !== null
      ? (settings.mcpServers as Record<string, unknown>)
      : {};
  if (!mcpServers[BROKER_MCP_NAME]) {
    mcpServers[BROKER_MCP_NAME] = mcpEntry(brokerDir, options);
    settings.mcpServers = mcpServers;
    mcpAdded = true;
  }
  if (!serialized.includes(GATE_MARKER)) {
    const hooks =
      typeof settings.hooks === "object" && settings.hooks !== null
        ? (settings.hooks as Record<string, unknown>)
        : {};
    const preToolUse = Array.isArray(hooks.PreToolUse)
      ? (hooks.PreToolUse as unknown[])
      : [];
    preToolUse.push({
      hooks: [
        {
          type: "command",
          command: gateCommand(brokerDir, "qwen", options),
          timeout: 15000,
        },
      ],
    });
    hooks.PreToolUse = preToolUse;
    settings.hooks = hooks;
    hookAdded = true;
  }
  if (mcpAdded || hookAdded)
    writeAtomic(settingsPath, JSON.stringify(settings, null, 2));
  return { mcpAdded, hookAdded };
}

/** cursor: ~/.cursor/mcp.json only; hooks are not a cursor-agent surface. */
export function ensureCursorBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const cursorDir = path.join(home(options), ".cursor");
  const configPath = path.join(cursorDir, "mcp.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof config;
  } catch {
    config = {};
  }
  const servers = config.mcpServers ?? {};
  if (servers[BROKER_MCP_NAME]) return { mcpAdded: false, hookAdded: false };
  config.mcpServers = {
    ...servers,
    [BROKER_MCP_NAME]: mcpEntry(brokerDir, options),
  };
  fs.mkdirSync(cursorDir, { recursive: true });
  writeAtomic(configPath, JSON.stringify(config, null, 2));
  return { mcpAdded: true, hookAdded: false };
}

function tomlLiteral(value: string): string {
  // TOML literal strings pass Windows backslashes through untouched; only a
  // quote inside the path forces the basic-string escape route.
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * codex: config.toml is append-only. Array-of-tables blocks remain valid
 * TOML when appended at the end, so the managed block never reformats the
 * owner's file; a timestamped backup is written first.
 */
export function ensureCodexBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const codexDir = path.join(home(options), ".codex");
  const configPath = path.join(codexDir, "config.toml");
  let body = "";
  try {
    body = fs.readFileSync(configPath, "utf8");
  } catch {
    body = "";
  }
  const hasMcp = /\[mcp_servers\.(cukii-broker|agent-hub-broker)\]/.test(body);
  const hasGate = body.includes(GATE_MARKER);
  if (hasMcp && hasGate) return { mcpAdded: false, hookAdded: false };
  const backup = path.join(codexDir, `config.toml.bak-cukii-${Date.now()}`);
  if (body) fs.writeFileSync(backup, body, { encoding: "utf8" });
  const py = brokerPythonCommand(options);
  const block: string[] = ["", MANAGED_MARKER];
  if (!hasMcp) {
    block.push(
      "[mcp_servers.cukii-broker]",
      `command = ${tomlLiteral(py)}`,
      `args = [${tomlLiteral(path.join(brokerDir, "mcp_server.py"))}]`,
      "",
      "[mcp_servers.cukii-broker.env]",
      'PYTHONIOENCODING = "utf-8"',
      'PYTHONUTF8 = "1"',
    );
  }
  if (!hasGate) {
    block.push(
      "",
      "[[hooks.PreToolUse]]",
      "",
      "[[hooks.PreToolUse.hooks]]",
      'type = "command"',
      `command = ${tomlLiteral(gateCommand(brokerDir, "codex", options))}`,
      "timeout = 15",
    );
  }
  writeAtomic(configPath, body + block.join("\n") + "\n");
  return { mcpAdded: !hasMcp, hookAdded: !hasGate };
}

/** grok: official `mcp add` for the server, a plugin-owned hook file alongside agent-hub.json. */
export function ensureGrokBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const spawnFn = options?.spawn ?? spawnSync;
  let mcpAdded = false;
  try {
    const result = spawnFn(
      "grok",
      [
        "mcp",
        "add",
        BROKER_MCP_NAME,
        "-e",
        "PYTHONIOENCODING=utf-8",
        "-e",
        "PYTHONUTF8=1",
        "--",
        brokerPythonCommand(options),
        path.join(brokerDir, "mcp_server.py"),
      ],
      { timeout: 30000, encoding: "utf8" },
    );
    mcpAdded = result.status === 0;
  } catch {
    mcpAdded = false;
  }
  let hookAdded = false;
  try {
    const hooksDir = path.join(home(options), ".grok", "hooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, GROK_HOOK_FILENAME);
    let current = "";
    try {
      current = fs.readFileSync(hookPath, "utf8");
    } catch {
      current = "";
    }
    const wanted = JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: gateCommand(brokerDir, "grok", options),
                  timeout: 15,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    );
    if (current.trim() !== wanted.trim()) {
      writeAtomic(hookPath, wanted);
      hookAdded = true;
    }
  } catch {
    hookAdded = false;
  }
  return { mcpAdded, hookAdded };
}

/**
 * kimi: ~/.kimi-code/mcp.json carries the server (same shape as cursor's),
 * config.toml gets an append-only [[hooks]] block. Kimi parses the deny
 * envelope natively on PreToolUse (canary-verified on 0.38.0), so the gate
 * registers directly, without the prompt-injection adapter.
 */
export function ensureKimiBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const kimiDir = path.join(home(options), ".kimi-code");
  let mcpAdded = false;
  try {
    const configPath = path.join(kimiDir, "mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof config;
    } catch {
      config = {};
    }
    const servers = config.mcpServers ?? {};
    if (!servers[BROKER_MCP_NAME]) {
      config.mcpServers = {
        ...servers,
        [BROKER_MCP_NAME]: mcpEntry(brokerDir, options),
      };
      fs.mkdirSync(kimiDir, { recursive: true });
      writeAtomic(configPath, JSON.stringify(config, null, 2));
      mcpAdded = true;
    }
  } catch {
    mcpAdded = false;
  }
  let hookAdded = false;
  try {
    const configPath = path.join(kimiDir, "config.toml");
    const body = fs.readFileSync(configPath, "utf8");
    if (!body.includes(GATE_MARKER)) {
      const backup = path.join(kimiDir, `config.toml.bak-cukii-${Date.now()}`);
      if (body) fs.writeFileSync(backup, body, { encoding: "utf8" });
      const block: string[] = [
        "",
        MANAGED_MARKER,
        "[[hooks]]",
        'event = "PreToolUse"',
        `command = ${tomlLiteral(gateCommand(brokerDir, "kimi", options))}`,
        "timeout = 15",
      ];
      writeAtomic(configPath, body + block.join("\n") + "\n");
      hookAdded = true;
    }
  } catch {
    hookAdded = false;
  }
  return { mcpAdded, hookAdded };
}

/**
 * Pre-spawn wiring for one broker model. Memoized per vendor+home, safe to
 * call on every launch, and never throws into the run.
 */
export function ensureBrokerVendorIntegration(
  model: BrokerModel,
  options?: BrokerIntegrationOptions,
): VendorRegistration | undefined {
  try {
    const vendor = brokerVendorForModel(model);
    const key = `${vendor}:${home(options)}`;
    if (completed.has(key)) return undefined;
    const brokerDir = resolveBrokerDir(options);
    if (!brokerDir)
      return {
        mcpAdded: false,
        hookAdded: false,
        skipped: "broker package not resolved",
      };
    let result: VendorRegistration | undefined;
    switch (vendor) {
      case "qwen":
        result = ensureQwenBrokerRegistration(brokerDir, options);
        break;
      case "codex":
        result = ensureCodexBrokerRegistration(brokerDir, options);
        break;
      case "cursor":
        result = ensureCursorBrokerRegistration(brokerDir, options);
        break;
      case "grok":
        result = ensureGrokBrokerRegistration(brokerDir, options);
        break;
      case "kimi":
        result = ensureKimiBrokerRegistration(brokerDir, options);
        break;
      default:
        result = undefined; // claude (native stdin), deepseek (not connected)
    }
    completed.add(key);
    return result;
  } catch {
    return undefined;
  }
}

/** Test-only: drop the per-vendor memo so repeated scenarios re-run. */
export function resetBrokerIntegrationMemoForTests(): void {
  completed.clear();
}
