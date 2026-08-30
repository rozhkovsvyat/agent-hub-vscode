import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChatMessage, PromptLog } from "core";
import type {
  BrokerEffort,
  BrokerModel,
  BrokerSpeed,
  BrokerSubagent,
  CukiiPermissionMode,
} from "core/protocol/ideWebview";
import * as vscode from "vscode";

import { terminateBridgeChild } from "./bridgeChildLifecycle";
import { BridgeEvent, BridgeEventParser, BridgeFormat } from "./bridgeEvents";
import { describeBridgeLaunch, grokPromptJson } from "./grokPrompt";
import { buildBridgeTranscript } from "./bridgeTranscript";
import {
  closeFollowers,
  drainFollowers,
  registerNestedWorkerFollower,
  type NestedWorkerFollower,
} from "./nestedWorkerFollow";
import { BridgeSteeringController } from "./bridgeSteer";
import {
  bridgeControlPrompt,
  bridgeControlSummary,
  claudeControlArgs,
  codexControlArgs,
  cursorModelId,
  grokControlArgs,
  permissionControlArgs,
  resolveBridgeControls,
  type BridgeControlResolution,
} from "./bridgeControls";
import {
  ensureCursorCatalogVariants,
  resolveCursorCatalogModel,
} from "./bridgeModelCatalog";
import {
  ClaudePermissionBroker,
  type ClaudePermissionRequest,
} from "./claudePermissionBroker";

export type BridgeRoute = {
  label: string;
  program: string;
  args: string[];
  /** Формат stdout нативного CLI: от него зависит разбор в события. */
  format: BridgeFormat;
  promptFile?: string;
  logFile: string;
  /**
   * CLI получает промпт аргументом и stdin не читает (kimi -p). Писать туда весь
   * транскрипт нельзя: непрочитанный pipe переполняется и даёт EPIPE/зависание.
   */
  noStdin?: boolean;
  stdinFormat?: "claude-stream-json";
};

export type ClaudePermissionTransport = {
  panelId: string;
  sessionId: string;
  onRequest: (request: ClaudePermissionRequest) => Promise<void> | void;
  onBrokerCreated?: (broker: ClaudePermissionBroker) => void;
  onBrokerDisposed?: (broker: ClaudePermissionBroker) => void;
  steering?: BridgeSteeringController;
  onToolActivity?: (event: { kind: "start" | "finish"; id: string }) => void;
  abortSignal?: AbortSignal;
};

/** Appends the documented Claude MCP permission transport without ever placing
 * the pipe token/config content in argv. Exported for exact launch regression
 * tests; the broker owns config-file lifecycle. */
export function attachClaudePermissionTransport(
  route: BridgeRoute,
  broker: ClaudePermissionBroker,
): void {
  route.args.push(...broker.claudeArgs());
}

type ResolvedCommand = {
  program: string;
  args: string[];
};

type BridgeEnv = NodeJS.ProcessEnv;

const MODEL_LABELS: Record<string, string> = {
  "opus-5": "Opus 5",
  "sonnet-5": "Sonnet 5",
  "fable-5": "Fable 5",
  "haiku-4-5": "Haiku 4.5",
  "codex-5-6-terra": "GPT-5.6 Terra",
  "codex-5-6-sol": "GPT-5.6 Sol",
  "codex-5-6-luna": "GPT-5.6 Luna",
  "codex-5-5": "GPT-5.5",
  "codex-5-4": "GPT-5.4",
  "codex-5-4-mini": "GPT-5.4 Mini",
  "grok-4-6": "Grok 4.6",
  "grok-4-5": "Grok 4.5",
  "composer-2-5": "Composer 2.5",
  // Enum id остаётся kimi-k2 ради совместимости с persist'ом globalState.
  // Дефолт подписки — kimi-code/kimi-for-coding (K2.7 Coding), поэтому витрина —
  // «Kimi K2.7». K3 у подписки тоже есть (kimi-code/k3).
  "kimi-k2": "Kimi K2.7",
  "kimi-k2-highspeed": "Kimi K2.7 Highspeed",
  "kimi-k3": "Kimi K3",
  "kimi-k3-256k": "Kimi K3-256K",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "qwen-3-8-max": "Qwen 3.8 Max",
};

const CODEX_NATIVE_MODELS: Record<string, string> = {
  "codex-5-6-sol": "gpt-5.6-sol",
  "codex-5-6-terra": "gpt-5.6-terra",
  "codex-5-6-luna": "gpt-5.6-luna",
  "codex-5-5": "gpt-5.5",
  "codex-5-4": "gpt-5.4",
  "codex-5-4-mini": "gpt-5.4-mini",
};

const KIMI_NATIVE_MODELS: Record<string, string | undefined> = {
  "kimi-k2": "kimi-code/kimi-for-coding",
  "kimi-k2-highspeed": "kimi-code/kimi-for-coding-highspeed",
  "kimi-k3": "kimi-code/k3",
  "kimi-k3-256k": "kimi-code/k3-256k",
};

function displayBridgeModel(model: BrokerModel): string {
  return (
    MODEL_LABELS[model] ??
    model.replace(/^(?:codex|kimi|grok|cursor):/, "").replaceAll("-", " ")
  );
}

function codexNativeModel(model: BrokerModel): string | undefined {
  return (
    CODEX_NATIVE_MODELS[model] ??
    (model.startsWith("codex:") ? model.slice("codex:".length) : undefined)
  );
}

function kimiNativeModel(model: BrokerModel): string | undefined {
  if (Object.prototype.hasOwnProperty.call(KIMI_NATIVE_MODELS, model)) {
    return KIMI_NATIVE_MODELS[model];
  }
  return model.startsWith("kimi:") ? model.slice("kimi:".length) : undefined;
}

function grokNativeModel(model: BrokerModel): string | undefined {
  if (model === "grok-4-6") return "grok-4.6";
  if (model === "grok-4-5") return "grok-4.5";
  return model.startsWith("grok:") ? model.slice("grok:".length) : undefined;
}

// Kimi едет собственным ПОДПИСОЧНЫМ CLI `kimi` (Kimi Code, device-login на
// kimi.ai/global — flat-fee + квота), а НЕ платным per-token API и НЕ через
// claude CLI: у аккаунта обычно только consumer-подписка, ключ Kimi Code Console
// недоступен, а подписочный CLI работает как Grok/Cursor — свой агент-луп на
// подписке. Токен кладёт `kimi login` (managed, в лог/UI не попадает). Паритет
// памяти/хуков claude здесь НЕ наследуется — это отдельная работа «свои хуки для
// Kimi» (config.toml MCP + --skills-dir), см. follow-up.
//
// Windows CreateProcess ограничивает командную строку ~32k символов, а `kimi -p`
// берёт промпт АРГУМЕНТОМ (stdin в prompt-режиме не читает — проверено прогоном).
// Поэтому большой транскрипт уводим в файл и просим kimi прочитать его тулом.
const KIMI_INLINE_PROMPT_BUDGET = 24_000;

function kimiCliProgram(): string {
  return "kimi";
}

/**
 * Skills для Kimi CLI (`--skills-dir`). Паритет с Claude/Codex: те же каталоги,
 * что подключаются через `.claude/skills` и `.codex/skills`. Разрешаем симлинки
 * сами и возвращаем только директории, содержащие `SKILL.md`/`skill.md` — так
 * битые symlink'и внутри skill-рута не ломают запуск Kimi.
 */
function getKimiSkillDirs(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills"),
    "D:\\Brain\\repo\\personal\\agent-hub-vscode\\skills",
    "D:\\Brain\\vault\\fm-reboot\\.claude\\skills",
  ];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const candidate = path.join(root, entry);
        const real = fs.realpathSync(candidate);
        if (seen.has(real.toLowerCase())) continue;
        if (!fs.statSync(real).isDirectory()) continue;
        if (
          !fs.existsSync(path.join(real, "SKILL.md")) &&
          !fs.existsSync(path.join(real, "skill.md"))
        ) {
          continue;
        }
        seen.add(real.toLowerCase());
        dirs.push(real);
      } catch {
        // skip broken symlinks or unreadable entries
      }
    }
  }
  return dirs;
}

function windowsCmdPath(): string {
  const fallback = "C:\\Windows\\System32\\cmd.exe";
  const comSpec = process.env.ComSpec;
  if (
    comSpec &&
    path.isAbsolute(comSpec) &&
    comSpec.toLowerCase().endsWith("\\cmd.exe") &&
    fs.existsSync(comSpec)
  ) {
    return comSpec;
  }
  return fallback;
}

function buildPrompt(
  messages: ChatMessage[],
  brokerModel: BrokerModel,
  brokerSubagent: BrokerSubagent,
  cwd: string,
  controls: BridgeControlResolution,
  permissionMode: CukiiPermissionMode,
): string {
  const subagent =
    brokerSubagent === "auto" ? "Auto" : displayBridgeModel(brokerSubagent);
  const selectedSubagentGuidance =
    brokerSubagent === "auto"
      ? "Subagent routing is Auto: choose the strongest appropriate native worker and say which one you chose."
      : [
          `Subagent routing is locked to ${displayBridgeModel(brokerSubagent)}.`,
          "If the user asks you to delegate, you MUST use that selected native worker.",
          "Do not use Claude Code's built-in Agent/Explore/Task subagent as a substitute for a selected Cukii subagent.",
          "If the selected native worker cannot be launched, report that failure explicitly instead of silently falling back.",
          // Раньше здесь была только shell-подсказка, поэтому делегирование
          // зависело от того, догадается ли модель вызвать инструмент. Называем
          // оба пути и правило выбора между ними явно.
          "Two delegation mechanisms exist; pick by where the work lives.",
          "(1) Work inside a Cukii vault scope (work, fm, housing, agents, hub):" +
            ` call mcp__cukii-broker__broker_delegate with agent="${brokerAgentId(brokerSubagent)}",` +
            ` model="${displayBridgeModel(brokerSubagent)}" and an EXPLICIT scope argument,` +
            " then poll broker_status and finish with broker_accept." +
            " The scope argument is mandatory unless the task text names the scope itself:" +
            " without it routing cannot resolve and delegation is refused.",
          `(2) Work outside those vault roots — including this workspace at ${cwd} —` +
            " is not routable by the broker: run the native CLI yourself instead:" +
            ` ${nativeDelegateHint(brokerSubagent, cwd, permissionMode)}`,
          "Report which of the two mechanisms you used.",
          // Вложенный worker пишет в свой процесс, и его ход в ленту не попадает:
          // окно видит только сам вызов и его результат. Пока нет мультиплекса
          // вложенного потока, связность обеспечивает рассказ брокера.
          "Narrate the delegation as it happens: one short line BEFORE you launch" +
            " the worker saying what you are handing over and to whom, and one line" +
            " AFTER it returns saying what it actually did and whether it succeeded." +
            " The user cannot see inside the worker process, so silence between" +
            " those lines reads as a freeze.",
        ].join(" ");

  const transcript = buildBridgeTranscript(messages);

  return [
    "You are Cukii Broker running through a native bridge, not through the Continue chat model.",
    `Broker model: ${displayBridgeModel(brokerModel)}.`,
    ...bridgeControlPrompt(controls),
    `Preferred subagent model: ${subagent}.`,
    selectedSubagentGuidance,
    "Use the local Codex/Claude/Grok/Cursor bridge environment and available Cukii MCP tools when delegation is useful.",
    "Answer in the user's language and keep normal chat continuity from the transcript.",
    "While working, write short status lines often — what you are doing now, not a spinner. Long silent stretches between tools read as a freeze.",
    ...(isClaudeNativeModel(brokerModel)
      ? [
          "The user may send live follow-up messages through this same native session. Treat each as current-task steering before the next model step.",
        ]
      : []),
    "",
    transcript,
  ].join("\n");
}

export function isClaudeNativeModel(model: BrokerModel): boolean {
  return ["opus-5", "sonnet-5", "fable-5", "haiku-4-5"].includes(model);
}

/** Имя worker-а в enum broker_delegate, а не витринная подпись модели. */
function brokerAgentId(
  model: BrokerModel,
): "codex" | "claude" | "grok" | "cursor" | "deepseek" | "qwen" {
  if (["opus-5", "sonnet-5", "fable-5", "haiku-4-5"].includes(model)) {
    return "claude";
  }
  if (codexNativeModel(model)) return "codex";
  if (grokNativeModel(model)) return "grok";
  if (model === "composer-2-5" || model.startsWith("cursor:")) return "cursor";
  // Broker protocol пока использует claude worker-channel для Moonshot.
  if (kimiNativeModel(model) !== undefined || model === "kimi-k2")
    return "claude";
  if (model === "deepseek-v4-pro") return "deepseek";
  return "qwen";
}

export function nativeDelegateHint(
  model: BrokerModel,
  cwd: string,
  permissionMode: CukiiPermissionMode,
): string {
  if (model === "deepseek-v4-pro") {
    return "deepseek bridge is not connected yet";
  }
  const permissionFlags = permissionControlArgs(model, permissionMode).join(
    " ",
  );
  const suffix = permissionFlags ? ` ${permissionFlags}` : "";
  const codexModel = codexNativeModel(model);
  if (codexModel) {
    return `codex -m ${codexModel} exec${suffix} --cd "${cwd}" -`;
  }
  const grokModel = grokNativeModel(model);
  if (grokModel) {
    return `grok --model ${grokModel}${suffix} --cwd "${cwd}" --prompt-file <task-file>`;
  }
  const kimiModel = kimiNativeModel(model);
  if (kimiModel || model === "kimi-k2") {
    return `kimi -p "<task>"${kimiModel ? ` -m ${kimiModel}` : ""}${suffix} --output-format stream-json`;
  }
  switch (model) {
    case "opus-5":
      return `claude --model claude-opus-5${suffix} -p "<task>"`;
    case "sonnet-5":
      return `claude --model claude-sonnet-5${suffix} -p "<task>"`;
    case "fable-5":
      return `claude --model claude-fable-5${suffix} -p "<task>"`;
    case "haiku-4-5":
      return `claude --model claude-haiku-4-5${suffix} -p "<task>"`;
    case "composer-2-5":
      return `${process.platform === "win32" ? "agent" : "cursor-agent"} -p --output-format text --model composer-2.5${suffix}`;
    case "qwen-3-8-max":
      return `qwen --model qwen3.8-max-preview --prompt "<task>" --output-format stream-json${suffix}`;
    default:
      return `${displayBridgeModel(model)} bridge route`;
  }
}

function bridgeLogFile(model: BrokerModel): string {
  return path.join(
    os.tmpdir(),
    `cukii-${model.replace(/[^a-z0-9._-]/gi, "-")}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
  );
}

// Anthropic documents this JSONL envelope for `-p --input-format stream-json`
// (Claude Code SDK, "Streaming JSON input"). Keeping stdin open is required
// for its realtime multi-turn transport; it is closed only on CLI completion
// or cancellation below.
function claudeStreamingInput(prompt: string): string {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  })}\n`;
}

function commandCandidates(program: string): string[] {
  if (
    process.platform !== "win32" ||
    program.includes("\\") ||
    program.includes("/")
  ) {
    return [program];
  }

  const home = os.homedir();
  return [
    // Avoid the npm .cmd shim for `--prompt-json`: cmd.exe has a much smaller
    // command-line budget than the native Grok executable.
    ...(program === "grok"
      ? [path.join(home, ".grok", "bin", "grok.exe")]
      : []),
    // Kimi Code CLI ставит нативный exe вне PATH — резолвим его напрямую, иначе
    // .cmd-шим съедает и без того тесный бюджет командной строки под транскрипт.
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

function resolveCommand(program: string, args: string[]): ResolvedCommand {
  const resolved = commandCandidates(program).find((candidate) =>
    candidate === program ? true : fs.existsSync(candidate),
  );
  const executable = resolved ?? program;

  if (
    process.platform === "win32" &&
    executable.toLowerCase().endsWith(".cmd")
  ) {
    return {
      program: windowsCmdPath(),
      args: ["/d", "/c", "call", executable, ...args],
    };
  }

  return { program: executable, args };
}

function appendPathSegment(
  segments: string[],
  candidate: string | undefined,
): void {
  if (!candidate || !fs.existsSync(candidate)) {
    return;
  }
  const normalized = candidate.toLowerCase();
  if (!segments.some((segment) => segment.toLowerCase() === normalized)) {
    segments.push(candidate);
  }
}

function bridgeEnv(model: BrokerModel, subagent: BrokerSubagent): BridgeEnv {
  const home = os.homedir();
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "Path";
  const rawPath = process.env[pathKey] ?? "";
  const segments = rawPath.split(path.delimiter).filter(Boolean);

  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    appendPathSegment(segments, path.join(systemRoot, "System32"));
    appendPathSegment(segments, systemRoot);
    appendPathSegment(segments, path.join(systemRoot, "System32", "Wbem"));
    appendPathSegment(
      segments,
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    );
    appendPathSegment(segments, "C:\\Program Files\\PowerShell\\7");
    appendPathSegment(
      segments,
      path.join(home, "scoop", "apps", "nodejs", "current", "bin"),
    );
    appendPathSegment(
      segments,
      path.join(home, "scoop", "persist", "nodejs", "bin"),
    );
    appendPathSegment(segments, path.join(home, "AppData", "Roaming", "npm"));
    appendPathSegment(segments, path.join(home, ".local", "bin"));
  }

  const env: BridgeEnv = {
    ...process.env,
    [pathKey]: segments.join(path.delimiter),
    ...(process.platform === "win32" ? { ComSpec: windowsCmdPath() } : {}),
    CUKII_BRIDGE_MODE: "broker",
    CUKII_BROKER_MODEL: model,
    CUKII_SUBAGENT_MODEL: subagent,
  };

  // Kimi аутентифицируется собственным device-токеном (`kimi login`), а не через
  // ANTHROPIC_*-переменные — специальная env-обвязка ему не нужна.

  return env;
}

function ensureProgramAvailable(route: BridgeRoute): ResolvedCommand {
  const probeCommand = resolveCommand(route.program, ["--version"]);
  const probe = spawnSync(probeCommand.program, probeCommand.args, {
    encoding: "utf8",
    env: bridgeEnv("fable-5", "auto"),
    shell: false,
    windowsHide: true,
  });
  if (probe.error) {
    throw new Error(
      `${route.label} bridge is unavailable: cannot start "${route.program}". ` +
        "Install/authenticate the native CLI or select another broker model.",
    );
  }
  return resolveCommand(route.program, route.args);
}

export function routeForModel(
  model: BrokerModel,
  cwd: string,
  prompt: string,
  messages: ChatMessage[],
  controls: BridgeControlResolution,
  permissionMode: CukiiPermissionMode = "manual",
): BridgeRoute {
  const logFile = bridgeLogFile(model);
  // There is no executable DeepSeek route yet.  Do this before resolving a
  // permission capability, otherwise a missing capability would disguise the
  // deliberate transport error below.
  if (model === "deepseek-v4-pro") {
    throw new Error("DeepSeek bridge is not connected yet");
  }
  const permissionArgs = permissionControlArgs(model, permissionMode);
  const claudeModel = {
    "opus-5": "claude-opus-5",
    "sonnet-5": "claude-sonnet-5",
    "fable-5": "claude-fable-5",
    "haiku-4-5": "claude-haiku-4-5",
  }[model];
  if (claudeModel) {
    return {
      label: displayBridgeModel(model),
      program: "claude",
      args: [
        "--model",
        claudeModel,
        ...claudeControlArgs(controls),
        ...permissionArgs,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      format: "anthropic-envelope",
      stdinFormat: "claude-stream-json",
      logFile,
    };
  }
  const codexModel = codexNativeModel(model);
  if (codexModel) {
    return {
      label: displayBridgeModel(model),
      program: "codex",
      args: [
        "-m",
        codexModel,
        ...codexControlArgs(controls),
        "exec",
        "--json",
        ...permissionArgs,
        "--cd",
        cwd,
        "-",
      ],
      format: "codex-thread",
      logFile,
    };
  }
  const nativeGrokModel = grokNativeModel(model);
  if (nativeGrokModel) {
    const promptFile = path.join(
      os.tmpdir(),
      `cukii-grok-transcript-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
    );
    fs.writeFileSync(promptFile, prompt, "utf8");
    let promptJson: string;
    try {
      promptJson = grokPromptJson(messages, promptFile);
    } catch (error) {
      fs.rmSync(promptFile, { force: true });
      throw error;
    }
    return {
      label: displayBridgeModel(model),
      program: "grok",
      args: [
        "--model",
        nativeGrokModel,
        ...grokControlArgs(controls),
        ...permissionArgs,
        "--cwd",
        cwd,
        "--prompt-json",
        promptJson,
        "--output-format",
        "streaming-messages-json",
      ],
      format: "anthropic-envelope",
      promptFile,
      logFile,
    };
  }
  const nativeCursorModel = resolveCursorCatalogModel(
    model,
    controls.nativeEffort ?? controls.requestedEffort,
    controls.effectiveSpeed,
    controls.effectiveThinking,
  );
  if (nativeCursorModel) {
    return {
      label: displayBridgeModel(model),
      program: process.platform === "win32" ? "agent" : "cursor-agent",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--model",
        nativeCursorModel,
        ...permissionArgs,
      ],
      format: "anthropic-envelope",
      logFile,
    };
  }
  // Live Kimi provider discovery may return additional managed subscription
  // aliases.  They must retain the exact native alias selected in the picker:
  // falling back to K2 here would make a visible model a decorative option.
  const liveKimiModel = model.startsWith("kimi:")
    ? kimiNativeModel(model)
    : undefined;
  if (liveKimiModel) {
    const inline =
      Buffer.byteLength(prompt, "utf8") <= KIMI_INLINE_PROMPT_BUDGET;
    let promptArg = prompt;
    let kimiPromptFile: string | undefined;
    const extraArgs: string[] = [];
    if (!inline) {
      kimiPromptFile = path.join(
        os.tmpdir(),
        `cukii-kimi-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      fs.writeFileSync(kimiPromptFile, prompt, "utf8");
      promptArg =
        "Your full broker instructions and the conversation transcript are in " +
        `the file \"${kimiPromptFile}\". Read that file first, then act on the ` +
        "latest user message. Answer in the user's language.";
      extraArgs.push("--add-dir", os.tmpdir());
    }
    const skillDirs = getKimiSkillDirs();
    return {
      label: displayBridgeModel(model),
      program: kimiCliProgram(),
      args: [
        "-p",
        promptArg,
        "--output-format",
        "stream-json",
        "-m",
        liveKimiModel,
        ...permissionArgs,
        ...extraArgs,
        ...skillDirs.flatMap((dir) => ["--skills-dir", dir]),
      ],
      format: "kimi-ndjson",
      promptFile: kimiPromptFile,
      logFile,
      noStdin: true,
    };
  }
  switch (model) {
    // `--verbose` обязателен: без него `claude -p` не отдаёт stream-json.
    case "opus-5":
      return {
        label: displayBridgeModel(model),
        program: "claude",
        args: [
          "--model",
          "claude-opus-5",
          ...claudeControlArgs(controls),
          ...permissionArgs,
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        format: "anthropic-envelope",
        logFile,
      };
    case "fable-5":
      return {
        label: displayBridgeModel(model),
        program: "claude",
        args: [
          "--model",
          "claude-fable-5",
          ...claudeControlArgs(controls),
          ...permissionArgs,
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        format: "anthropic-envelope",
        logFile,
      };
    case "sonnet-5":
      return {
        label: displayBridgeModel(model),
        program: "claude",
        args: [
          "--model",
          "claude-sonnet-5",
          ...claudeControlArgs(controls),
          ...permissionArgs,
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        format: "anthropic-envelope",
        logFile,
      };
    // Kimi = подписочный CLI `kimi` (device-login), поток stream-json в формате
    // kimi-ndjson. Выбранная модель всегда передаётся exact native alias через
    // `-m`; иначе пользовательский K2 мог молча превратиться в default K3.
    // `-p` берёт промпт аргументом и stdin не читает, поэтому большой транскрипт
    // уходит в файл, а kimi получает короткую инструкцию прочитать его тулом.
    case "kimi-k2":
    case "kimi-k2-highspeed":
    case "kimi-k3":
    case "kimi-k3-256k": {
      const modelArg = kimiNativeModel(model);
      const inline =
        Buffer.byteLength(prompt, "utf8") <= KIMI_INLINE_PROMPT_BUDGET;
      let promptArg = prompt;
      let kimiPromptFile: string | undefined;
      const extraArgs: string[] = [];
      if (!inline) {
        kimiPromptFile = path.join(
          os.tmpdir(),
          `cukii-kimi-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
        );
        fs.writeFileSync(kimiPromptFile, prompt, "utf8");
        promptArg =
          "Your full broker instructions and the conversation transcript are in " +
          `the file "${kimiPromptFile}". Read that file first, then act on the ` +
          "latest user message. Answer in the user's language.";
        extraArgs.push("--add-dir", os.tmpdir());
      }
      const skillDirs = getKimiSkillDirs();
      return {
        label: displayBridgeModel(model),
        program: kimiCliProgram(),
        args: [
          "-p",
          promptArg,
          "--output-format",
          "stream-json",
          ...(modelArg ? ["-m", modelArg] : []),
          ...permissionArgs,
          ...extraArgs,
          ...skillDirs.flatMap((dir) => ["--skills-dir", dir]),
        ],
        format: "kimi-ndjson",
        promptFile: kimiPromptFile,
        logFile,
        noStdin: true,
      };
    }
    case "codex-5-6-terra":
      return {
        label: displayBridgeModel(model),
        program: "codex",
        args: [
          "-m",
          "gpt-5.6-terra",
          ...codexControlArgs(controls),
          "exec",
          "--json",
          ...permissionArgs,
          "--cd",
          cwd,
          "-",
        ],
        format: "codex-thread",
        logFile,
      };
    case "codex-5-6-sol":
      return {
        label: displayBridgeModel(model),
        program: "codex",
        args: [
          "-m",
          "gpt-5.6-sol",
          ...codexControlArgs(controls),
          "exec",
          "--json",
          ...permissionArgs,
          "--cd",
          cwd,
          "-",
        ],
        format: "codex-thread",
        logFile,
      };
    case "grok-4-6":
      const promptFile = path.join(
        os.tmpdir(),
        `cukii-grok-transcript-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
      );
      fs.writeFileSync(promptFile, prompt, "utf8");
      let promptJson: string;
      try {
        promptJson = grokPromptJson(messages, promptFile);
      } catch (error) {
        fs.rmSync(promptFile, { force: true });
        throw error;
      }
      return {
        label: displayBridgeModel(model),
        program: "grok",
        args: [
          "--model",
          "grok-4.6",
          ...grokControlArgs(controls),
          ...permissionArgs,
          "--cwd",
          cwd,
          "--prompt-json",
          promptJson,
          "--output-format",
          "streaming-messages-json",
        ],
        // Проверено прогоном: grok отдаёт тот же конверт, что claude stream-json.
        format: "anthropic-envelope",
        promptFile,
        logFile,
      };
    case "composer-2-5":
      const cursorModel = cursorModelId(controls);
      return {
        label: displayBridgeModel(model),
        program: process.platform === "win32" ? "agent" : "cursor-agent",
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--model",
          cursorModel,
          ...permissionArgs,
        ],
        format: "anthropic-envelope",
        logFile,
      };
    case "deepseek-v4-pro":
      throw new Error(
        "DeepSeek bridge is not connected yet. Select another model.",
      );
    case "qwen-3-8-max":
      return {
        label: displayBridgeModel(model),
        program: "qwen",
        args: [
          "--model",
          "qwen3.8-max-preview",
          "--prompt",
          "Follow the Cukii broker instructions supplied on stdin.",
          "--output-format",
          "stream-json",
          ...permissionArgs,
        ],
        // Qwen Code stream-json follows the assistant/user/result envelope
        // consumed by the same parser as Claude and Grok.
        format: "anthropic-envelope",
        logFile,
      };
    default:
      if (model.startsWith("kimi:")) {
        const modelArg = kimiNativeModel(model);
        return routeForModel(
          modelArg === "kimi-code/k3"
            ? "kimi-k3"
            : modelArg === "kimi-code/k3-256k"
              ? "kimi-k3-256k"
              : modelArg === "kimi-code/kimi-for-coding-highspeed"
                ? "kimi-k2-highspeed"
                : "kimi-k2",
          cwd,
          prompt,
          messages,
          controls,
          permissionMode,
        );
      }
      throw new Error(
        `${displayBridgeModel(model)} is not wired to a native Cukii bridge route.`,
      );
  }
}

/**
 * Событие моста -> сообщения ленты чата.
 *
 * `toolStart` едет отдельным assistant-сообщением с ПУСТЫМ контентом: редьюсер
 * прикрепляет tool-call к последнему assistant-сообщению только в этом случае
 * (ветка без messageContent в sessionSlice.streamUpdate). Инструмент уже выполнен
 * внутри worker-а, поэтому GUI переводит его в состояние done и НИКОГДА не
 * исполняет повторно — это витрина чужой работы, а не запрос на подтверждение.
 */
function toChatMessages(event: BridgeEvent): ChatMessage[] {
  switch (event.kind) {
    case "text":
      return [{ role: "assistant", content: event.text }];
    case "thinking":
      return [{ role: "thinking", content: event.text }];
    case "toolStart":
      return [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: event.id,
              type: "function",
              function: { name: event.name, arguments: event.args },
            },
          ],
        },
      ];
    case "toolResult":
      return [
        {
          role: "tool",
          content: event.output,
          toolCallId: event.id,
          // This is bridge-private transport metadata. It reaches the Redux
          // thunk with the observed result and prevents a failed native tool
          // from being painted as a successful action.
          cukiiToolError: event.isError,
        },
      ] as unknown as ChatMessage[];
    case "error":
      return [{ role: "assistant", content: `\n\n⚠️ ${event.text}\n` }];
  }
}

export async function* streamBridgeChat(
  args: {
    sessionId: string;
    messages: ChatMessage[];
    brokerModel: BrokerModel;
    brokerSubagent: BrokerSubagent;
    brokerEffort: BrokerEffort;
    brokerSpeed: BrokerSpeed;
    thinkingEnabled: boolean;
    brokerPermissionMode: CukiiPermissionMode;
  },
  permissionTransport?: ClaudePermissionTransport,
): AsyncGenerator<ChatMessage, PromptLog> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();
  return yield* streamBridgeChatWithSteer(args, cwd, permissionTransport);
}

async function* streamBridgeChatWithSteer(
  args: {
    sessionId: string;
    messages: ChatMessage[];
    brokerModel: BrokerModel;
    brokerSubagent: BrokerSubagent;
    brokerEffort: BrokerEffort;
    brokerSpeed: BrokerSpeed;
    thinkingEnabled: boolean;
    brokerPermissionMode: CukiiPermissionMode;
  },
  cwd: string,
  permissionTransport?: ClaudePermissionTransport,
): AsyncGenerator<ChatMessage, PromptLog> {
  // The model picker fills this cache in the normal path. A restored saved
  // session may send before that picker opens, so rebuild it on demand.
  await ensureCursorCatalogVariants(args.brokerModel);
  const controls = resolveBridgeControls(
    args.brokerModel,
    args.brokerEffort,
    args.brokerSpeed,
    args.thinkingEnabled,
  );
  const prompt = buildPrompt(
    args.messages,
    args.brokerModel,
    args.brokerSubagent,
    cwd,
    controls,
    args.brokerPermissionMode,
  );
  const route = routeForModel(
    args.brokerModel,
    cwd,
    prompt,
    args.messages,
    controls,
    args.brokerPermissionMode,
  );
  let permissionBroker: ClaudePermissionBroker | undefined;
  if (
    ["opus-5", "sonnet-5", "fable-5", "haiku-4-5"].includes(args.brokerModel) &&
    args.brokerPermissionMode !== "bypass"
  ) {
    if (!permissionTransport) {
      throw new Error(
        "Claude permission transport is unavailable for this Cukii panel.",
      );
    }
    permissionBroker = new ClaudePermissionBroker({
      panelId: permissionTransport.panelId,
      sessionId: args.sessionId || permissionTransport.sessionId,
      mode: args.brokerPermissionMode,
      onRequest: permissionTransport.onRequest,
    });
    await permissionBroker.start();
    attachClaudePermissionTransport(route, permissionBroker);
    permissionTransport.onBrokerCreated?.(permissionBroker);
  }
  permissionTransport?.abortSignal?.throwIfAborted();
  const subagentLabel =
    args.brokerSubagent === "auto"
      ? "Auto"
      : displayBridgeModel(args.brokerSubagent);
  yield {
    role: "thinking",
    content:
      `Starting ${route.label} broker bridge.\n` +
      `${bridgeControlSummary(controls)}\n` +
      `Subagent route: ${subagentLabel}.\n` +
      (args.brokerSubagent === "auto"
        ? "Auto routing may choose the strongest available native worker.\n"
        : `Selected subagent is locked; built-in Agent/Explore fallback is forbidden.\n`),
  };
  let command: ResolvedCommand;
  try {
    command = ensureProgramAvailable(route);
  } catch (err) {
    if (route.promptFile) {
      fs.rmSync(route.promptFile, { force: true });
    }
    if (permissionBroker) {
      await permissionBroker.dispose();
      permissionTransport?.onBrokerDisposed?.(permissionBroker);
    }
    throw err;
  }
  yield {
    role: "thinking",
    content: `Launching native command: ${describeBridgeLaunch(command.program, command.args)}\n`,
  };

  const child = spawn(command.program, command.args, {
    cwd,
    env: bridgeEnv(args.brokerModel, args.brokerSubagent),
    shell: false,
    windowsHide: true,
  });
  let cancelled = false;
  let done = false;
  const queue: BridgeEvent[] = [];
  const abortChild = () => {
    cancelled = true;
    queue.length = 0;
    done = true;
    permissionBroker?.denyAll();
  };
  permissionTransport?.abortSignal?.addEventListener("abort", abortChild, {
    once: true,
  });
  if (permissionTransport?.abortSignal?.aborted) abortChild();

  let completion = "";
  let stderr = "";
  let stdoutTail = "";
  let rawStdout = "";
  const launchedAt = Date.now();
  let firstOutputAt: number | undefined;

  if (!route.noStdin && !cancelled) {
    child.stdin.write(
      route.stdinFormat === "claude-stream-json"
        ? claudeStreamingInput(prompt)
        : prompt,
    );
    if (!route.stdinFormat) child.stdin.end();
    if (route.stdinFormat === "claude-stream-json") {
      permissionTransport?.steering?.attachWriter(
        (text) =>
          new Promise<boolean>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve(false);
              return;
            }
            child.stdin.write(claudeStreamingInput(text), (error) =>
              resolve(!error),
            );
          }),
      );
    }
  }

  const parser = new BridgeEventParser(route.format);
  const toolNamesById = new Map<string, string>();
  const followers: NestedWorkerFollower[] = [];
  let error: Error | undefined;

  child.stdout.on("data", (chunk: Buffer) => {
    if (cancelled) return;
    if (firstOutputAt === undefined) {
      firstOutputAt = Date.now();
      queue.push({
        kind: "thinking",
        text: `Native bridge first output after ${((firstOutputAt - launchedAt) / 1000).toFixed(1)} s.\n`,
      });
    }
    const text = chunk.toString("utf8");
    stdoutTail = (stdoutTail + text).slice(-4000);
    // Сырой stdout нужен только как страховка: если вендор сменит формат и не
    // разберётся ни одно событие, пользователь обязан увидеть ответ, а не пустоту.
    if (rawStdout.length < 2_000_000) {
      rawStdout += text;
    }
    const events = parser.push(text);
    for (const event of events) {
      if (event.kind === "toolStart") {
        permissionTransport?.onToolActivity?.({ kind: "start", id: event.id });
      }
      if (event.kind === "toolResult") {
        permissionTransport?.onToolActivity?.({ kind: "finish", id: event.id });
      }
    }
    queue.push(...events);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    fs.appendFileSync(route.logFile, text, "utf8");
  });
  child.once("error", (err) => {
    if (cancelled) return;
    error = err;
    done = true;
  });
  child.once("close", (code) => {
    child.stdin.end();
    if (cancelled) {
      done = true;
      return;
    }
    const events = parser.flush();
    for (const event of events) {
      if (event.kind === "toolResult") {
        permissionTransport?.onToolActivity?.({ kind: "finish", id: event.id });
      }
    }
    queue.push(...events);
    if (!cancelled && code && code !== 0) {
      const detail = stderr.trim() || stdoutTail.trim();
      error = new Error(
        `${route.label} bridge exited with code ${code}.` +
          (detail
            ? ` ${detail}`
            : " Native CLI stopped before returning a normal response.") +
          ` Bridge log: ${route.logFile}`,
      );
    }
    done = true;
  });

  // Потребитель может бросить генератор на середине (кнопка Stop в чате). Без
  // finally дочерний CLI оставался жить: он дописывал ответ в никуда, продолжал
  // тратить токены и мог править файлы уже после того, как пользователь остановил
  // ответ. Полная отмена требует ещё и проброса AbortSignal через протокол —
  // здесь закрыт только гарантированный процессный хвост.
  try {
    while (!done || queue.length) {
      const next = queue.shift();
      if (next) {
        if (next.kind === "text") {
          completion += next.text;
        }
        registerNestedWorkerFollower(next, toolNamesById, followers);
        for (const message of toChatMessages(next)) {
          yield message;
        }
      } else {
        const nestedThinking = drainFollowers(followers);
        if (nestedThinking.length) {
          for (const message of nestedThinking) {
            yield message;
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      }
    }
    for (const message of drainFollowers(followers)) {
      yield message;
    }
    if (
      route.format !== "text" &&
      !parser.sawStructuredOutput &&
      rawStdout.trim()
    ) {
      completion += rawStdout;
      yield { role: "assistant", content: rawStdout };
    }
  } finally {
    permissionTransport?.abortSignal?.removeEventListener("abort", abortChild);
    permissionTransport?.steering?.close();
    closeFollowers(followers);
    child.stdin.end();
    await terminateBridgeChild(child);
    if (route.promptFile) {
      fs.rmSync(route.promptFile, { force: true });
    }
    if (permissionBroker) {
      await permissionBroker.dispose();
      permissionTransport?.onBrokerDisposed?.(permissionBroker);
    }
  }

  if (error && !cancelled) {
    throw error;
  }

  return {
    modelTitle: route.label,
    modelProvider: "cukii-bridge",
    prompt,
    completion,
  };
}
