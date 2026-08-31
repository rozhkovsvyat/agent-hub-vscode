import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { BrokerVendorId } from "core/protocol/ideWebview";
import {
  parseVendorPermissionCapabilities,
  type VendorPermissionCapabilities,
} from "core/cukiiPermissionModes";

const VENDOR_PROGRAMS: Record<BrokerVendorId, string | undefined> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  // Official native Windows Cursor CLI: `agent --version`.
  cursor: "agent",
  kimi: "kimi",
  qwen: "qwen",
  deepseek: undefined,
};

type ProbeCommand = { program: string; argsPrefix: string[]; route: string };
type ProbeOutput = { stdout: string; stderr: string; failed: boolean };

// Failed probes are deliberately not cached: installing a CLI while VS Code
// stays open must be visible on the next request.
const cache = new Map<string, VendorPermissionCapabilities>();
let claudePermissionWorkerReady: Promise<boolean> | undefined;

/**
 * Do not advertise interactive Claude modes merely because the CLI help lists
 * them. The packaged standalone MCP worker must prove initialize + tools/list
 * first, otherwise Manual/Edit/Auto would deadlock a headless bridge.
 */
export function selfTestClaudePermissionWorker(): Promise<boolean> {
  if (claudePermissionWorkerReady) return claudePermissionWorkerReady;
  const probe = new Promise<boolean>((resolve) => {
    const worker = path.join(__dirname, "claudePermissionMcpWorker.js");
    if (!fs.existsSync(worker)) {
      resolve(false);
      return;
    }
    const child = spawn(process.execPath, [worker], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolve(ready);
    };
    const timeout = setTimeout(() => finish(false), 2_000);
    child.once("error", () => finish(false));
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const frames = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>];
          } catch {
            return [];
          }
        });
      if (
        frames.some(
          (frame) => frame.id === 1 && typeof frame.result === "object",
        ) &&
        frames.some(
          (frame) =>
            frame.id === 2 &&
            Array.isArray(
              (frame.result as { tools?: unknown[] } | undefined)?.tools,
            ) &&
            (frame.result as { tools: { name?: string }[] }).tools.some(
              (tool) => tool.name === "request",
            ),
        )
      ) {
        finish(true);
      }
    });
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
    );
  });
  claudePermissionWorkerReady = probe.then((ready) => {
    // A build/watch race must not hide Claude modes until VS Code is restarted.
    // Cache only a proved worker; a failed probe is retried next discovery.
    if (!ready) claudePermissionWorkerReady = undefined;
    return ready;
  });
  return claudePermissionWorkerReady;
}

function commandCandidates(program: string): string[] {
  if (process.platform !== "win32") return [program];
  const home = os.homedir();
  return [
    ...(program === "grok"
      ? [path.join(home, ".grok", "bin", "grok.exe")]
      : []),
    ...(program === "kimi"
      ? [path.join(home, ".kimi-code", "bin", "kimi.exe")]
      : []),
    ...(program === "agent"
      ? [
          path.join(home, ".cursor", "bin", "agent.exe"),
          path.join(
            home,
            "AppData",
            "Local",
            "Programs",
            "Cursor",
            "resources",
            "app",
            "bin",
            "agent.exe",
          ),
        ]
      : []),
    path.join(
      home,
      "scoop",
      "apps",
      "nodejs",
      "current",
      "bin",
      `${program}.cmd`,
    ),
    path.join(home, "scoop", "persist", "nodejs", "bin", `${program}.cmd`),
    path.join(home, "AppData", "Roaming", "npm", `${program}.cmd`),
    path.join(home, ".local", "bin", `${program}.exe`),
    program,
  ];
}

function quoteCmdToken(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * `cmd.exe` expands `%VAR%` even inside quoted tokens. Do not attempt to
 * escape that grammar: routes with expansion or quote-control characters are
 * unavailable, rather than becoming a command line. `!` is denied as defense
 * in depth even though probes also explicitly disable delayed expansion.
 */
function isSafeCmdProbeRoute(route: string): boolean {
  return !/[%!"\r\n]/.test(route);
}

/**
 * Windows cannot CreateProcess a .cmd directly (EINVAL). Invoke only a known
 * candidate plus a fixed probe flag through ComSpec, with shell disabled.
 */
export function probeCommandForRoute(route: string): ProbeCommand {
  if (process.platform !== "win32" || !route.toLowerCase().endsWith(".cmd")) {
    return { program: route, argsPrefix: [], route };
  }
  return {
    program: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
    argsPrefix: ["/d", "/v:off", "/s", "/c", `call ${quoteCmdToken(route)}`],
    route,
  };
}

function resolveProbeCommand(program: string): ProbeCommand | undefined {
  const candidate = commandCandidates(program).find((entry) =>
    entry.includes("\\") || entry.includes("/") ? fs.existsSync(entry) : true,
  );
  return candidate ? probeCommandForRoute(candidate) : undefined;
}

function runProbe(command: ProbeCommand, flag: string): Promise<ProbeOutput> {
  return new Promise((resolve) => {
    const args = command.argsPrefix.length
      ? [
          ...command.argsPrefix.slice(0, -1),
          `${command.argsPrefix.at(-1)} ${flag}`,
        ]
      : [flag];
    const child = spawn(command.program, args, {
      shell: false,
      windowsHide: true,
      // Node quotes each argument for CreateProcess by default. For the fixed
      // `cmd.exe /c call "<trusted .cmd route>" --help` form that changes the
      // route quotes into literal backslashes, so cmd cannot find the script.
      // Pass this known command line verbatim; native executables retain the
      // usual Node argument quoting.
      windowsVerbatimArguments:
        process.platform === "win32" && command.argsPrefix.length > 0,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 2_000);
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", () => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, failed: true });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, failed: code !== 0 });
    });
  });
}

async function probeCli(program: string): Promise<{
  help: string;
  version?: string;
  route?: string;
}> {
  const command = resolveProbeCommand(program);
  if (!command) return { help: "" };
  return probeCliCommand(program, command);
}

/**
 * Exercise the same live child-process probe against a supplied route.
 * Production discovery still accepts routes only from commandCandidates().
 */
export async function probeCliRoute(
  program: string,
  route: string,
): Promise<{
  help: string;
  version?: string;
  route?: string;
}> {
  return probeCliCommand(program, probeCommandForRoute(route));
}

async function probeCliCommand(
  program: string,
  command: ProbeCommand,
): Promise<{
  help: string;
  version?: string;
  route?: string;
}> {
  // This is before runProbe(), so an unsafe route never reaches spawn().
  if (command.argsPrefix.length > 0 && !isSafeCmdProbeRoute(command.route)) {
    return { help: "" };
  }
  const [help, version] = await Promise.all([
    runProbe(command, "--help"),
    runProbe(command, "--version"),
  ]);
  const helpText = `${help.stdout}\n${help.stderr}`.trim();
  const versionText = version.stdout.trim().split(/\r?\n/)[0];
  if (help.failed || version.failed || !helpText || !versionText)
    return { help: "" };

  if (program === "qwen" && !helpText.includes("approval-mode")) {
    const invalid = await runProbe(command, "--approval-mode");
    return {
      help: `${helpText}\n${invalid.stderr}`.trim(),
      version: versionText,
      route: command.route,
    };
  }
  return { help: helpText, version: versionText, route: command.route };
}

export function clearPermissionCapabilityCacheForTests(): void {
  cache.clear();
  claudePermissionWorkerReady = undefined;
}

export function cachedVendorPermissionCapabilities(
  vendor: BrokerVendorId,
): VendorPermissionCapabilities | undefined {
  const prefix = `${vendor}:`;
  return [...cache.entries()].find(([key]) => key.startsWith(prefix))?.[1];
}

export async function vendorPermissionCapabilities(
  vendor: BrokerVendorId,
): Promise<VendorPermissionCapabilities> {
  const program = VENDOR_PROGRAMS[vendor];
  if (!program)
    return { vendor, supportedModes: [], helpSource: "unavailable-route" };
  const probe = await probeCli(program);
  if (!probe.help || !probe.version || !probe.route) {
    return { vendor, supportedModes: [], helpSource: "unavailable-route" };
  }
  const key = `${vendor}:${probe.route}:${probe.version}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const capabilities = parseVendorPermissionCapabilities(
    vendor,
    probe.help,
    probe.version,
    vendor === "claude" ? await selfTestClaudePermissionWorker() : false,
  );
  cache.set(key, capabilities);
  return capabilities;
}

export async function allVendorPermissionCapabilities(): Promise<
  Record<BrokerVendorId, VendorPermissionCapabilities>
> {
  const vendors = [
    "claude",
    "codex",
    "grok",
    "cursor",
    "kimi",
    "qwen",
    "deepseek",
  ] as const;
  const results = await Promise.all(
    vendors.map((vendor) => vendorPermissionCapabilities(vendor)),
  );
  return Object.fromEntries(
    results.map((result) => [result.vendor, result]),
  ) as Record<BrokerVendorId, VendorPermissionCapabilities>;
}
