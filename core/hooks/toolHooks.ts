import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Logger } from "../util/Logger.js";

type CommandHook = {
  type: "command";
  command: string;
  timeout?: number;
  async?: boolean;
};

type HttpHook = {
  type: "http";
  url: string;
  timeout?: number;
  headers?: Record<string, string>;
};

type Hook = CommandHook | HttpHook;

type HookGroup = {
  matcher?: string;
  hooks?: Hook[];
};

type HookSettings = {
  hooks?: Record<string, HookGroup[]>;
  disableAllHooks?: boolean;
};

export type ToolHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "UserPromptSubmit"
  | "SessionStart"
  | "SessionEnd"
  | "Stop"
  | "PreCompact";

export type ToolHooksResult = {
  blocked: boolean;
  reason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
};

function loadHookSettings(filePath: string): HookSettings | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as HookSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      Logger.warn(`Failed to load hooks from ${filePath}: ${String(error)}`);
    }
    return undefined;
  }
}

function getHookGroups(
  cwd: string,
  event: ToolHookEvent,
  overrideSettingsPaths?: string[],
): HookGroup[] {
  const home = os.homedir();
  const continueHome =
    process.env.CONTINUE_GLOBAL_DIR || path.join(home, ".continue");
  const settingsPaths = overrideSettingsPaths ?? [
    path.join(home, ".claude", "settings.json"),
    path.join(continueHome, "settings.json"),
    path.join(cwd, ".claude", "settings.json"),
    path.join(cwd, ".continue", "settings.json"),
    path.join(cwd, ".claude", "settings.local.json"),
    path.join(cwd, ".continue", "settings.local.json"),
  ];

  const loaded = settingsPaths
    .map((settingsPath) => loadHookSettings(settingsPath))
    .filter((settings): settings is HookSettings => settings !== undefined);
  const groups: HookGroup[] = [];
  // Settings are ordered global -> project -> local. `disableAllHooks` can disable
  // hooks introduced at its own precedence only; it must never suppress a mandatory
  // global lifecycle gate supplied by ~/.claude/settings.json.
  for (const settings of loaded) {
    if (settings.disableAllHooks) continue;
    groups.push(...(settings.hooks?.[event] ?? []));
  }
  return groups;
}

function matches(group: HookGroup, toolName: string): boolean {
  if (!group.matcher || group.matcher === "*") return true;
  try {
    return new RegExp(group.matcher).test(toolName);
  } catch {
    Logger.warn(`Invalid hook matcher: ${group.matcher}`);
    return false;
  }
}

async function executeCommand(
  hook: CommandHook,
  input: Record<string, unknown>,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  // On Windows, Node escapes embedded quotes as \" — which cmd.exe does not understand.
  // A command like `pwsh -File "C:\path\hook.ps1"` then reaches pwsh with the quotes as
  // part of the file name and dies with exit 64 before running a single line. Every hook
  // configured the way Claude Code writes them was silently skipped. Pass the command
  // verbatim inside one extra pair of quotes, the way cmd.exe expects.
  const args = isWindows
    ? ["/d", "/s", "/c", `"${hook.command}"`]
    : ["-c", hook.command];
  const timeout = (hook.timeout ?? 600) * 1000;

  return await new Promise((resolve) => {
    const child = execFile(shell, args, {
      cwd,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      windowsVerbatimArguments: isWindows,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (data: string) => (stdout += data));
    child.stderr?.on("data", (data: string) => (stderr += data));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(input));
    child.on("close", (code) =>
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      }),
    );
    child.on("error", (error) => {
      Logger.warn(`Hook command failed: ${hook.command}; ${error.message}`);
      resolve({ stdout: "", stderr: error.message, exitCode: 1 });
    });
  });
}

async function executeHttp(
  hook: HttpHook,
  input: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    (hook.timeout ?? 30) * 1000,
  );
  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...hook.headers },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const stdout = await response.text();
    return {
      stdout: stdout.trim(),
      stderr: response.ok ? "" : `HTTP ${response.status}`,
      exitCode: response.ok ? 0 : 1,
    };
  } catch (error) {
    return { stdout: "", stderr: String(error), exitCode: 1 };
  } finally {
    clearTimeout(timeout);
  }
}

function parseOutput(stdout: string): any {
  if (!stdout.startsWith("{")) return undefined;
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

async function runHooks(
  event: ToolHookEvent,
  input: Record<string, unknown>,
  matcherValue: string,
  cwd: string,
  overrideSettingsPaths?: string[],
): Promise<ToolHooksResult> {
  const hooks = getHookGroups(cwd, event, overrideSettingsPaths)
    .filter((group) => matches(group, matcherValue))
    .flatMap((group) => group.hooks ?? [])
    .filter((hook) => hook.type === "command" || hook.type === "http");

  let updatedInput: unknown;
  const additionalContextParts: string[] = [];
  for (const hook of hooks) {
    if (hook.type === "command" && hook.async) {
      void executeCommand(hook, input, cwd);
      continue;
    }
    const result =
      hook.type === "command"
        ? await executeCommand(hook, input, cwd)
        : await executeHttp(hook, input);
    const output = parseOutput(result.stdout);
    // A hook that failed to start is indistinguishable from a hook that approved: both
    // end up in the `blocked: false` branch below. Keeping that fail-open behaviour is
    // deliberate — a broken mandatory gate must not brick the session — but staying quiet
    // about it is what let a completely dead hook wiring go unnoticed.
    if (result.exitCode !== 0 && result.exitCode !== 2 && !output) {
      Logger.warn(
        `Hook exited with ${result.exitCode} and produced no parsable output, ` +
          `treating as allowed: ${hook.type === "command" ? hook.command : hook.url}` +
          (result.stderr ? ` :: ${result.stderr.slice(0, 400)}` : ""),
      );
    }
    const specific = output?.hookSpecificOutput;
    if (specific?.additionalContext) {
      additionalContextParts.push(specific.additionalContext);
    }
    if (event === "PreToolUse" && specific?.updatedInput !== undefined) {
      updatedInput = specific.updatedInput;
    }
    const denied = specific?.permissionDecision === "deny";
    if (result.exitCode === 2 || output?.decision === "block" || denied) {
      return {
        blocked: true,
        reason:
          specific?.permissionDecisionReason ||
          output?.reason ||
          result.stderr ||
          "Blocked by hook",
        updatedInput,
        additionalContext: additionalContextParts.join("\n") || undefined,
      };
    }
  }
  return {
    blocked: false,
    updatedInput,
    additionalContext: additionalContextParts.join("\n") || undefined,
  };
}

export async function runToolHooks(
  event: Extract<
    ToolHookEvent,
    "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  >,
  toolName: string,
  toolInput: unknown,
  toolUseId: string,
  cwd: string,
  extra: Record<string, unknown> = {},
  overrideSettingsPaths?: string[],
  sessionId = "",
  transcriptPath = "",
): Promise<ToolHooksResult> {
  return runHooks(
    event,
    {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      hook_event_name: event,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
      ...extra,
    },
    toolName,
    cwd,
    overrideSettingsPaths,
  );
}

export async function runLifecycleHooks(
  event: Exclude<
    ToolHookEvent,
    "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  >,
  fields: Record<string, unknown>,
  cwd: string,
  sessionId: string,
  transcriptPath: string,
  matcherValue = "",
  overrideSettingsPaths?: string[],
): Promise<ToolHooksResult> {
  return runHooks(
    event,
    {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      hook_event_name: event,
      ...fields,
    },
    matcherValue,
    cwd,
    overrideSettingsPaths,
  );
}
