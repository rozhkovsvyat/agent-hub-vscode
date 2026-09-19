import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  withOwnerFileLock,
  writeOwnerFileAtomic,
} from "./ownerFileTransaction";

import type { BrokerModel } from "core/protocol/ideWebview";
import { brokerVendorForModel } from "core/cukiiPermissionModes";
import {
  registerRunBinding,
  type CukiiRunBinding,
} from "./bridgeRunBinding";

/**
 * Idempotent vendor-side wiring for the broker inbox channel. The inbox
 * itself lives in `~/.continue/cukii-inbox`; what each vendor needs is
 * (1) the cukii-broker MCP server registered so `broker_inbox` /
 * `broker_send` are callable mid-run, and (2) the strict PreToolUse gate
 * hook that force-delivers messages which outlived their grace window.
 * Every function is fail-open: a registration problem must never block the
 * run — the turn-end drain fallback still delivers queued messages.
 *
 * Claude needs no inbox gate because stdin interrupts live, but it does need
 * the managed MCP server for Cukii's vendor-agnostic request_user_input UI.
 */

export const BROKER_MCP_NAME = "cukii-broker";
export const QUESTION_MCP_NAME = "cukii-question";
const GATE_MARKER = "inbox_gate.py";
const MANAGED_MARKER = "# cukii-inbox-channel (managed by the Cukii plugin)";
const GROK_HOOK_FILENAME = "cukii-inbox.json";

export interface BrokerIntegrationOptions {
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to node's spawnSync (grok MCP only). */
  spawn?: typeof spawnSync;
  registerBinding?: typeof registerRunBinding;
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
  runId: string,
  messageIds: string[] = [],
  options?: BrokerIntegrationOptions,
): CukiiRunBinding | undefined {
  if (!Number.isSafeInteger(vendorPid) || vendorPid <= 0) return undefined;
  const binding = (options?.registerBinding ?? registerRunBinding)(
    vendorPid,
    sessionId,
    runId,
  );
  if (!binding || messageIds.length === 0) return binding;
  const brokerDir = resolveBrokerDir(options);
  if (!brokerDir) return binding;
  try {
    const spawnFn = options?.spawn ?? spawnSync;
    const result = spawnFn(
      brokerPythonCommand(options),
      [
        path.join(brokerDir, "session_identity.py"),
        "--lease-existing",
        String(vendorPid),
        ...messageIds.flatMap((messageId) => ["--message-id", messageId]),
      ],
      {
        timeout: 5000,
        encoding: "utf8",
        env: envOf(options),
      },
    );
    return result.status === 0 ? binding : undefined;
  } catch {
    return undefined;
  }
}

function questionMcpEntry() {
  return {
    command: process.execPath,
    args: [path.join(__dirname, "cukiiQuestionMcp.js")],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      CUKII_QUESTION_MANAGED: "1",
    },
  };
}

function managedQuestionEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { args?: unknown; env?: Record<string, unknown> };
  return (
    Array.isArray(entry.args) &&
    entry.args.some(
      (arg) =>
        typeof arg === "string" &&
        path.basename(arg) === "cukiiQuestionMcp.js",
    ) &&
    entry.env?.CUKII_QUESTION_MANAGED === "1"
  );
}

function ensureJsonQuestionServer(configPath: string): boolean {
  return withOwnerFileLock(configPath, () => {
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof config;
      } catch {
        return false;
      }
    }
    if (
      config.mcpServers !== undefined &&
      (typeof config.mcpServers !== "object" ||
        config.mcpServers === null ||
        Array.isArray(config.mcpServers))
    ) {
      return false;
    }
    const servers = config.mcpServers ?? {};
    const existing = servers[QUESTION_MCP_NAME];
    if (existing && !managedQuestionEntry(existing)) return false;
    const wanted = questionMcpEntry();
    if (JSON.stringify(existing) === JSON.stringify(wanted)) return false;
    config.mcpServers = { ...servers, [QUESTION_MCP_NAME]: wanted };
    writeOwnerFileAtomic(configPath, JSON.stringify(config, null, 2));
    return true;
  });
}

const QUESTION_TOML_BEGIN = "# cukii-question managed begin";
const QUESTION_TOML_END = "# cukii-question managed end";

function ensureTomlQuestionServer(configPath: string): boolean {
  return withOwnerFileLock(configPath, () => {
    let body = "";
    try {
      body = fs.readFileSync(configPath, "utf8");
    } catch {
      // A missing config is created; an existing unreadable one fails below.
      if (fs.existsSync(configPath)) return false;
    }
    const hasOwnerSection = /^\s*\[mcp_servers\.cukii-question\]\s*$/m.test(body);
    const start = body.indexOf(QUESTION_TOML_BEGIN);
    const end = body.indexOf(QUESTION_TOML_END);
    if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) return false;
    if (hasOwnerSection && (start < 0 || end < start)) return false;
    const entry = questionMcpEntry();
    const block = [
      QUESTION_TOML_BEGIN,
      "[mcp_servers.cukii-question]",
      `command = ${tomlLiteral(entry.command)}`,
      `args = [${tomlLiteral(entry.args[0])}]`,
      "[mcp_servers.cukii-question.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
      'CUKII_QUESTION_MANAGED = "1"',
      QUESTION_TOML_END,
    ].join("\n");
    const next =
      start >= 0 && end >= start
        ? `${body.slice(0, start)}${block}${body.slice(end + QUESTION_TOML_END.length)}`
        : `${body.trimEnd()}\n\n${block}\n`;
    if (next === body) return false;
    writeOwnerFileAtomic(configPath, next);
    return true;
  });
}

function ensureQuestionVendorRegistration(
  vendor: ReturnType<typeof brokerVendorForModel>,
  options?: BrokerIntegrationOptions,
): boolean {
  const root = home(options);
  switch (vendor) {
    case "claude":
      return ensureJsonQuestionServer(path.join(root, ".claude.json"));
    case "qwen":
      return ensureJsonQuestionServer(path.join(root, ".qwen", "settings.json"));
    case "cursor":
      return ensureJsonQuestionServer(path.join(root, ".cursor", "mcp.json"));
    case "kimi":
      return ensureJsonQuestionServer(path.join(root, ".kimi-code", "mcp.json"));
    case "codex":
      return ensureTomlQuestionServer(path.join(root, ".codex", "config.toml"));
    case "grok":
      return ensureTomlQuestionServer(path.join(root, ".grok", "config.toml"));
    default:
      return false;
  }
}

function mcpEntry(brokerDir: string, options?: BrokerIntegrationOptions) {
  return {
    command: brokerPythonCommand(options),
    args: [path.join(brokerDir, "mcp_server.py")],
    env: {
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      // The broker is imported as the `broker` package; without its parent
      // on PYTHONPATH the server dies with ModuleNotFoundError on every run.
      PYTHONPATH: path.dirname(brokerDir),
    },
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

/**
 * Qwen's harness splits hook commands on whitespace without shell quoting:
 * a quoted script path reaches python as a literal filename containing quote
 * characters, the gate never starts, and every tool call is denied. The
 * command must therefore stay unquoted, which forbids spaces in the gate
 * path. A spaced gate (a profile like `C:\Users\Иван Петров`) is served
 * through a shim at a space-free path — never by "fixing" the space with
 * quotes, because quoting is exactly the defect this prevents. When even the
 * shim root carries a space the registration fails closed with an actionable
 * message. Codex/grok/kimi keep the quoted form: their TOML/JSON parsers
 * consume the quotes.
 */
function qwenGateCommand(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): string {
  const gate = path.join(brokerDir, "hooks", GATE_MARKER);
  let target = gate;
  if (gate.includes(" ")) {
    if (process.platform !== "win32") {
      throw qwenGateRegistrationError(
        gate,
        "no persistent space-free shim location exists on this platform",
      );
    }
    target = qwenGateShimPath(options);
    if (target.includes(" ")) {
      throw qwenGateRegistrationError(
        gate,
        `even the shim root (${envOf(options).ProgramData ?? "C:\\ProgramData"}) contains a space`,
      );
    }
    // Write (or refresh) the shim as part of computing the command so a
    // relocated broker package cannot leave a stale exec path behind.
    writeQwenGateShim(gate, options);
  }
  const command = `${brokerPythonCommand(options)} ${target} -Harness qwen`;
  if (command.includes('"') || command.includes("'")) {
    throw qwenGateRegistrationError(
      gate,
      `the command picks up a quote character: ${command}`,
    );
  }
  return command;
}

function qwenGateRegistrationError(gate: string, detail: string): Error {
  return new Error(
    `cannot register the Cukii PreToolUse gate for qwen on host ${os.hostname()}: ` +
      `the gate path "${gate}" contains a space, and qwen splits hook commands on whitespace without shell quoting, so the path cannot be quoted either (${detail}). ` +
      `Fix: copy the broker package to a path without spaces, point CUKII_BROKER_DIR at it, and restart the bridge. ` +
      `Until then the broker inbox channel degrades to turn-end drain; tool calls are not blocked.`,
  );
}

/**
 * Space-free shim root for spaced gate paths. %ProgramData% survives reboots
 * (a temp-dir shim would vanish and every tool call would deny) and is
 * writable by the installing user. The shim file keeps the gate marker name
 * so the settings idempotency check still matches.
 */
function qwenGateShimPath(options?: BrokerIntegrationOptions): string {
  const base = envOf(options).ProgramData ?? "C:\\ProgramData";
  return path.join(base, "cukii", "qwen-gate", GATE_MARKER);
}

function qwenGateShimBody(gate: string): string {
  return [
    MANAGED_MARKER,
    "# Qwen splits hook commands on whitespace without shell quoting, so the",
    "# real gate below (its path contains a space) cannot be named in the hook",
    "# command. This shim lives at a space-free path and re-invokes the real",
    "# gate with argv and stdio passed through untouched.",
    "import subprocess",
    "import sys",
    "",
    `raise SystemExit(subprocess.call([sys.executable, ${JSON.stringify(gate)}, *sys.argv[1:]]))`,
    "",
  ].join("\n");
}

function writeQwenGateShim(
  gate: string,
  options?: BrokerIntegrationOptions,
): void {
  const shimPath = qwenGateShimPath(options);
  let current: string | undefined;
  try {
    current = fs.readFileSync(shimPath, "utf8");
  } catch {
    current = undefined;
  }
  if (current === qwenGateShimBody(gate)) return;
  writeOwnerFileAtomic(shimPath, qwenGateShimBody(gate));
}

/** qwen: settings.json carries both mcpServers and hooks (JSON-safe edit). */
function ensureQwenBrokerRegistrationUnlocked(
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
  // Qwen hides a `trust: false` MCP entirely in non-interactive runs, which
  // kills the broker channel without any UI signal. The broker is host-owned
  // infrastructure, so its entry must stay trusted; every registration
  // normalizes back to `trust: true` instead of silently re-breaking it.
  const brokerEntry = mcpServers[BROKER_MCP_NAME] as Record<string, unknown>;
  let trustNormalized = false;
  if (brokerEntry.trust !== true) {
    brokerEntry.trust = true;
    trustNormalized = true;
  }
  // Existing entries from before PYTHONPATH was required must gain it, or the
  // next broker launch dies with ModuleNotFoundError: No module named
  // 'broker'. Unknown-at-install values are never written as trust:false.
  const entryEnv =
    typeof brokerEntry.env === "object" && brokerEntry.env !== null
      ? (brokerEntry.env as Record<string, unknown>)
      : {};
  const wantedPythonPath = path.dirname(brokerDir);
  let pythonPathNormalized = false;
  if (entryEnv.PYTHONPATH !== wantedPythonPath) {
    entryEnv.PYTHONPATH = wantedPythonPath;
    brokerEntry.env = entryEnv;
    pythonPathNormalized = true;
  }
  // MCP registration is JSON-safe and does not care about spaces in the
  // broker path. The PreToolUse command is the one qwen splits on
  // whitespace, so a spaced gate degrades the hook (shim, or skip with a
  // human message) without rolling back the MCP entry.
  let desiredCommand: string | undefined;
  let hookSkipped: string | undefined;
  try {
    desiredCommand = qwenGateCommand(brokerDir, options);
  } catch (error) {
    hookSkipped =
      error instanceof Error ? error.message : String(error);
  }

  const hooks =
    typeof settings.hooks === "object" && settings.hooks !== null
      ? (settings.hooks as Record<string, unknown>)
      : {};
  const preToolUse = Array.isArray(hooks.PreToolUse)
    ? (hooks.PreToolUse as unknown[])
    : [];
  let hookNormalized = false;
  if (desiredCommand) {
    if (!serialized.includes(GATE_MARKER)) {
      preToolUse.push({
        hooks: [
          {
            type: "command",
            command: desiredCommand,
            timeout: 15000,
          },
        ],
      });
      hooks.PreToolUse = preToolUse;
      settings.hooks = hooks;
      hookAdded = true;
    } else if (rewriteQwenGateCommands(preToolUse, desiredCommand)) {
      hooks.PreToolUse = preToolUse;
      settings.hooks = hooks;
      hookNormalized = true;
    }
  }
  if (
    mcpAdded ||
    hookAdded ||
    hookNormalized ||
    trustNormalized ||
    pythonPathNormalized
  ) {
    writeOwnerFileAtomic(settingsPath, JSON.stringify(settings, null, 2));
  }
  return { mcpAdded, hookAdded, skipped: hookSkipped };
}

/**
 * Rewrite an already-registered qwen gate command (quoted, spaced, or
 * pointing at a stale shim) onto `desired`. Returns true when a command
 * string actually changed.
 */
function rewriteQwenGateCommands(
  preToolUse: unknown[],
  desired: string,
): boolean {
  let changed = false;
  for (const group of preToolUse) {
    if (!group || typeof group !== "object") continue;
    const hooks = (group as { hooks?: unknown }).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      if (!hook || typeof hook !== "object") continue;
      const rec = hook as { command?: unknown };
      const current = typeof rec.command === "string" ? rec.command : "";
      if (current.includes(GATE_MARKER) && current !== desired) {
        rec.command = desired;
        changed = true;
      }
    }
  }
  return changed;
}

export function ensureQwenBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const settingsPath = path.join(home(options), ".qwen", "settings.json");
  try {
    return withOwnerFileLock(settingsPath, () =>
      ensureQwenBrokerRegistrationUnlocked(brokerDir, options),
    );
  } catch (error) {
    return {
      mcpAdded: false,
      hookAdded: false,
      skipped: `qwen config busy: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** cursor: ~/.cursor/mcp.json only; hooks are not a cursor-agent surface. */
function ensureCursorBrokerRegistrationUnlocked(
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
  writeOwnerFileAtomic(configPath, JSON.stringify(config, null, 2));
  return { mcpAdded: true, hookAdded: false };
}

export function ensureCursorBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const configPath = path.join(home(options), ".cursor", "mcp.json");
  try {
    return withOwnerFileLock(configPath, () =>
      ensureCursorBrokerRegistrationUnlocked(brokerDir, options),
    );
  } catch {
    return { mcpAdded: false, hookAdded: false, skipped: "cursor config busy" };
  }
}

/** claude: use the official CLI so its large user config is never rewritten. */
function ensureClaudeBrokerRegistrationUnlocked(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const spawnFn = options?.spawn ?? spawnSync;
  const env = envOf(options);
  try {
    const existing = spawnFn("claude", ["mcp", "get", BROKER_MCP_NAME], {
      timeout: 5000,
      encoding: "utf8",
      env,
    });
    if (existing.status === 0) return { mcpAdded: false, hookAdded: false };
    const added = spawnFn(
      "claude",
      [
        "mcp",
        "add",
        "--transport",
        "stdio",
        "--scope",
        "user",
        "--env",
        "PYTHONIOENCODING=utf-8",
        "--env",
        "PYTHONUTF8=1",
        BROKER_MCP_NAME,
        "--",
        brokerPythonCommand(options),
        path.join(brokerDir, "mcp_server.py"),
      ],
      { timeout: 15_000, encoding: "utf8", env },
    );
    return {
      mcpAdded: added.status === 0,
      hookAdded: false,
      ...(added.status === 0 ? {} : { skipped: "claude mcp add failed" }),
    };
  } catch {
    return { mcpAdded: false, hookAdded: false, skipped: "claude unavailable" };
  }
}

export function ensureClaudeBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const configPath = path.join(home(options), ".claude.json");
  try {
    return withOwnerFileLock(configPath, () =>
      ensureClaudeBrokerRegistrationUnlocked(brokerDir, options),
    );
  } catch {
    return { mcpAdded: false, hookAdded: false, skipped: "claude config busy" };
  }
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
function ensureCodexBrokerRegistrationUnlocked(
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
  writeOwnerFileAtomic(configPath, body + block.join("\n") + "\n");
  return { mcpAdded: !hasMcp, hookAdded: !hasGate };
}

export function ensureCodexBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const configPath = path.join(home(options), ".codex", "config.toml");
  try {
    return withOwnerFileLock(configPath, () =>
      ensureCodexBrokerRegistrationUnlocked(brokerDir, options),
    );
  } catch {
    return { mcpAdded: false, hookAdded: false, skipped: "codex config busy" };
  }
}

/** grok: official `mcp add` for the server, a plugin-owned hook file alongside agent-hub.json. */
function ensureGrokBrokerRegistrationUnlocked(
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
      writeOwnerFileAtomic(hookPath, wanted);
      hookAdded = true;
    }
  } catch {
    hookAdded = false;
  }
  return { mcpAdded, hookAdded };
}

export function ensureGrokBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const configPath = path.join(home(options), ".grok", "config.toml");
  try {
    return withOwnerFileLock(configPath, () =>
      ensureGrokBrokerRegistrationUnlocked(brokerDir, options),
    );
  } catch {
    return { mcpAdded: false, hookAdded: false, skipped: "grok config busy" };
  }
}

/**
 * kimi: ~/.kimi-code/mcp.json carries the server (same shape as cursor's),
 * config.toml gets an append-only [[hooks]] block. Kimi parses the deny
 * envelope natively on PreToolUse (canary-verified on 0.38.0), so the gate
 * registers directly, without the prompt-injection adapter.
 */
function ensureKimiBrokerRegistrationUnlocked(
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
      writeOwnerFileAtomic(configPath, JSON.stringify(config, null, 2));
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
      writeOwnerFileAtomic(configPath, body + block.join("\n") + "\n");
      hookAdded = true;
    }
  } catch {
    hookAdded = false;
  }
  return { mcpAdded, hookAdded };
}

export function ensureKimiBrokerRegistration(
  brokerDir: string,
  options?: BrokerIntegrationOptions,
): VendorRegistration {
  const kimiDir = path.join(home(options), ".kimi-code");
  const mcpPath = path.join(kimiDir, "mcp.json");
  const hookPath = path.join(kimiDir, "config.toml");
  try {
    return withOwnerFileLock(mcpPath, () =>
      withOwnerFileLock(hookPath, () =>
        ensureKimiBrokerRegistrationUnlocked(brokerDir, options),
      ),
    );
  } catch {
    return { mcpAdded: false, hookAdded: false, skipped: "kimi config busy" };
  }
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
    const questionAdded = ensureQuestionVendorRegistration(vendor, options);
    const brokerDir = resolveBrokerDir(options);
    if (!brokerDir)
      return {
        mcpAdded: questionAdded,
        hookAdded: false,
        ...(questionAdded ? {} : { skipped: "broker package not resolved" }),
      };
    let result: VendorRegistration | undefined;
    switch (vendor) {
      case "claude":
        result = ensureClaudeBrokerRegistration(brokerDir, options);
        break;
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
        result = undefined; // deepseek (not connected)
    }
    if (result && questionAdded) result.mcpAdded = true;
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
