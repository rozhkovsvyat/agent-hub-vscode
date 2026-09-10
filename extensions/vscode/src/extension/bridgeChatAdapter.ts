import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChatMessage, MessageContent, PromptLog } from "core";
import {
  ALIBABA_CHAT_MODELS,
  isAlibabaChatModel,
  isAlibabaNonChatCapability,
} from "core/cukiiAlibabaCatalog";
import { brokerVendorForModel } from "core/cukiiPermissionModes";
import type {
  BrokerAutocompact,
  BrokerEffort,
  BrokerModel,
  BrokerSpeed,
  BrokerSubagent,
  CukiiPermissionMode,
} from "core/protocol/ideWebview";
import * as vscode from "vscode";
import { alibabaQwenArgv, alibabaSpawnEnv } from "./alibabaTokenPlan";

import { terminateBridgeChild } from "./bridgeChildLifecycle";
import { BridgeEvent, BridgeEventParser, BridgeFormat } from "./bridgeEvents";
import { brokerFactDisciplineDirective } from "./bridgeFactDiscipline";
import {
  bridgeInboxMessageStatus,
  markBridgeInboxMessagesRead,
} from "./bridgeInbox";
import {
  ensureBrokerVendorIntegration,
  registerBrokerSessionBinding,
} from "./bridgeVendorMcp";
import { describeBridgeLaunch, grokPromptJson } from "./grokPrompt";
import {
  BridgeImageScope,
  hasImageAttachment,
  parseSupportedVisionDataUrl,
  selectBridgeImageSources,
} from "./bridgeImages";
import { buildBridgeTranscript } from "./bridgeTranscript";
import { windowsVendorCliCandidates } from "./vendorCliCandidates";
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
  claudeProgram,
  ensureCursorCatalogVariants,
  resolveCursorCatalogModel,
} from "./bridgeModelCatalog";
import {
  ensureCodexModelsCacheCompatible,
  isCodexModelsCacheFailure,
  resolveCodexHome,
} from "./codexModelsCacheHeal";
import {
  ClaudePermissionBroker,
  type ClaudePermissionRequest,
} from "./claudePermissionBroker";
import {
  removeBridgeScratchFile,
  writeBridgeScratchFile,
} from "./bridgeScratch";
import {
  removeCaseInsensitiveEnvKeys,
  resolveBridgeStorageLayout,
} from "./bridgeStorageEnv";
import {
  RuntimeCanaryAttestation,
  runtimeCanaryExtensionBinding,
  runtimeCanaryResponseSummary,
  runtimeCanaryResult,
  runtimeCanaryTurn,
  type RuntimeCanaryReporter,
} from "./runtimeCanaryAttestation";
import { vendorPermissionCapabilities } from "./permissionCapabilities";

export type BridgeRoute = {
  label: string;
  program: string;
  args: string[];
  /** Формат stdout нативного CLI: от него зависит разбор в события. */
  format: BridgeFormat;
  promptFile?: string;
  logFile?: string;
  /**
   * CLI получает промпт аргументом и stdin не читает (kimi -p). Писать туда весь
   * транскрипт нельзя: непрочитанный pipe переполняется и даёт EPIPE/зависание.
   */
  noStdin?: boolean;
  stdinFormat?: "claude-stream-json";
};

export function queuedFollowUpEchoMessageId(
  messages: ChatMessage[],
  queuedFollowUpMessageIds: string[],
  vendorEcho: string,
  alreadyRead: ReadonlySet<string>,
): string | undefined {
  const echoed = vendorEcho.trim();
  for (const messageId of queuedFollowUpMessageIds) {
    if (alreadyRead.has(messageId)) continue;
    const content = messages.find(
      (message) => (message as ChatMessage & { id?: string }).id === messageId,
    )?.content;
    const text =
      typeof content === "string"
        ? content
        : content
            ?.filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    const expected = text?.trim();
    if (
      expected &&
      (echoed === expected || echoed.endsWith(`USER:\n${expected}`))
    ) {
      return messageId;
    }
  }
  return undefined;
}

export type ClaudePermissionTransport = {
  panelId: string;
  sessionId: string;
  onRequest: (request: ClaudePermissionRequest) => Promise<void> | void;
  /** Every change to the set of prompts still awaiting the user's answer. */
  onPendingChanged?: (requestIds: string[]) => void;
  onBrokerCreated?: (broker: ClaudePermissionBroker) => void;
  onBrokerDisposed?: (broker: ClaudePermissionBroker) => void;
  steering?: BridgeSteeringController;
  onToolActivity?: (event: { kind: "start" | "finish"; id: string }) => void;
  /** Local-controller receipt channel. Never persist canary events on Remote-SSH. */
  onRuntimeCanaryEvent?: RuntimeCanaryReporter;
  /** Reports whether the spawned vendor process tree was verified terminated. */
  onTerminationResult?: (terminated: boolean) => void;
  /** Reports the vendor child pid once known; undefined on spawn failure. */
  onChildSpawned?: (pid: number | undefined) => void;
  /** Run-owned files referenced by cold-start and broker-inbox image prompts. */
  imageScope?: BridgeImageScope;
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
  "fable-5-1": "Fable 5.1",
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
  ...Object.fromEntries(
    ALIBABA_CHAT_MODELS.map((model) => [model.value, model.label]),
  ),
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
  if (!model.startsWith("kimi:")) {
    return undefined;
  }
  const alias = model.slice("kimi:".length);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(alias)) {
    throw new Error(
      "Kimi native model alias must be 1-128 safe ASCII characters.",
    );
  }
  return alias;
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
// Kimi CLI documents -p/--prompt, but not an stdin input mode. Check the
// complete quoted CreateProcess command line below before anything launches.
/** CreateProcess permits 32,767 UTF-16 code units including its NUL terminator. */
const WINDOWS_CREATEPROCESS_SAFE_UTF16 = 32_766;
const WINDOWS_CMD_SAFE_UTF16 = 8_190;
export const KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16 =
  WINDOWS_CREATEPROCESS_SAFE_UTF16;

function isKimiModel(model: BrokerModel): boolean {
  return (
    model === "kimi-k2" ||
    model.startsWith("kimi-") ||
    model.startsWith("kimi:")
  );
}

function quoteWindowsCommandLineArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/u.test(argument)) {
    return argument;
  }

  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
    } else if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      quoted += "\\".repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/**
 * JavaScript string length is UTF-16 code units, the unit CreateProcessW
 * accepts. Compute after every final argument and Windows escaping are known.
 */
export function windowsCommandLineUtf16Length(
  program: string,
  args: string[],
): number {
  return [program, ...args].map(quoteWindowsCommandLineArgument).join(" ")
    .length;
}

function assertKimiWindowsCommandLine(program: string, args: string[]): void {
  if (process.platform !== "win32") {
    return;
  }
  const length = windowsCommandLineUtf16Length(program, args);
  if (length > WINDOWS_CREATEPROCESS_SAFE_UTF16) {
    throw new Error(
      "Kimi command line is " +
        length +
        " UTF-16 code units after Windows quoting; the safe CreateProcess limit is " +
        WINDOWS_CREATEPROCESS_SAFE_UTF16 +
        ".",
    );
  }
}

function assertGrokWindowsCommandLine(program: string, args: string[]): void {
  if (process.platform !== "win32") {
    return;
  }
  const length = windowsCommandLineUtf16Length(program, args);
  const safeLimit =
    path.basename(program).toLowerCase() === "cmd.exe"
      ? WINDOWS_CMD_SAFE_UTF16
      : WINDOWS_CREATEPROCESS_SAFE_UTF16;
  if (length > safeLimit) {
    throw new Error(
      "Grok command line is " +
        length +
        " UTF-16 code units after Windows quoting; the safe CreateProcess limit is " +
        safeLimit +
        ". The vendor did not start. Send fewer images or select another broker model.",
    );
  }
}

function kimiCliProgram(): string {
  return "kimi";
}

/**
 * `kimi -p` takes the prompt only from argv — no stdin input mode, no prompt
 * file flag (verified against `kimi --help`). Once a transcript outgrows the
 * CreateProcess command line, the only remaining transport is an exclusive
 * Scratch file that the agent reads as its first action.
 */
function kimiSpillLoaderPrompt(promptFile: string): string {
  return (
    "Your complete task briefing and conversation transcript are stored in the file " +
    promptFile +
    ". First read that file in full with your file-read tool; it is the exact content you must work from. " +
    "Then follow those instructions precisely and answer the latest user request in them. " +
    "Do not mention the file path to the user."
  );
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
  hasImages: boolean,
  steerInterrupt?: boolean,
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
    ...brokerFactDisciplineDirective(),
    ...(isClaudeNativeModel(brokerModel)
      ? [
          "The user may send live follow-up messages through this same native session. Treat each as current-task steering before the next model step.",
        ]
      : []),
    ...brokerInboxDirective(brokerModel),
    ...(steerInterrupt
      ? [
          "The latest user message was injected while you were mid-task; the previous turn was interrupted so you would see it promptly. Address this newest message first, then resume the task you were working on, taking it into account. Do not discard your prior work unless the new message changes the task.",
        ]
      : []),
    ...(hasImages && !isClaudeNativeModel(brokerModel)
      ? [
          "User-attached images appear in the transcript as @<absolute path> references. If an image did not arrive inline in your view, read the file at that path with your file-reading tool before answering.",
        ]
      : []),
    "",
    transcript,
  ].join("\n");
}

export function isClaudeNativeModel(model: BrokerModel): boolean {
  return ["opus-5", "sonnet-5", "fable-5", "fable-5-1", "haiku-4-5"].includes(
    model,
  );
}

/**
 * Live pull-steering through the broker inbox needs the cukii-broker MCP
 * server loaded by the vendor CLI. Every MCP-capable vendor is wired by
 * `ensureBrokerVendorIntegration` at spawn time; claude has the stronger
 * native stdin channel.
 */
export function supportsBrokerInbox(model: BrokerModel): boolean {
  const vendor = brokerVendorForModel(model);
  return (
    vendor === "qwen" ||
    vendor === "codex" ||
    vendor === "grok" ||
    vendor === "cursor" ||
    vendor === "kimi"
  );
}

/** Broker-prompt lines for inbox pull-steering; empty where unsupported. */
export function brokerInboxDirective(model: BrokerModel): string[] {
  if (isClaudeNativeModel(model) || !supportsBrokerInbox(model)) return [];
  return [
    "The user can also publish follow-ups while you work; they land in a broker inbox instead of this transcript." +
      " At natural step boundaries (before starting a new significant step, or after a long tool sequence) call the available MCP tool whose base name is broker_inbox; its qualified prefix may be cukii-broker or agent-hub-broker." +
      " If it returns messages, that array is the complete newly offered FIFO batch: read and address every item together as immediate input before resuming your task. A later call never repeats an outstanding batch to the same live reader; outstandingMessageIds are receipts to ack, not new instructions to process again." +
      " Only after the entire batch is understood and every referenced @file is accessible, call the available broker_inbox_ack tool with all exact messageId values; this acknowledgement is what permits read receipts and deduplication. If you fail before ack, the batch must be delivered again." +
      " Messages carry `from` — `user` for the human, `agent:<sessionId>` for parallel plugin sessions writing you through the same channel." +
      " Empty results are normal; never call it more than once per step boundary." +
      " Classify every incoming item by intent: an addition or correction augments the current task, so continue the same work after incorporating it; an explicit replacement switches the task; only an explicit stop/cancel request ends the run without another tool call. A normal follow-up must never stop the run." +
      " A message left unread too long is force-delivered: your next tool call is paused and its text arrives in the denial reason. Process that displayed batch once and call broker_inbox_ack directly with the displayed IDs; do not call broker_inbox to reread it. Then continue unless that message explicitly told you to stop.",
    "To coordinate with parallel sessions, the same channel is bidirectional: the available broker_sessions tool lists live sessions and broker_send writes one of them a message" +
      " (status or fact requests, handoff notes). Sending new work to a worker is still broker_delegate, never broker_send.",
  ];
}

/** Имя worker-а в enum broker_delegate, а не витринная подпись модели. */
function brokerAgentId(
  model: BrokerModel,
): "codex" | "claude" | "grok" | "cursor" | "deepseek" | "qwen" {
  if (
    ["opus-5", "sonnet-5", "fable-5", "fable-5-1", "haiku-4-5"].includes(model)
  ) {
    return "claude";
  }
  if (codexNativeModel(model)) return "codex";
  if (grokNativeModel(model)) return "grok";
  if (model === "composer-2-5" || model.startsWith("cursor:")) return "cursor";
  // Broker protocol пока использует claude worker-channel для Moonshot.
  if (kimiNativeModel(model) !== undefined || model === "kimi-k2")
    return "claude";
  if (isAlibabaChatModel(model) || model.startsWith("qwen")) return "qwen";
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
    case "fable-5-1":
      return `claude --model claude-fable-5-1${suffix} -p "<task>"`;
    case "haiku-4-5":
      return `claude --model claude-haiku-4-5${suffix} -p "<task>"`;
    case "composer-2-5":
      return `${process.platform === "win32" ? "agent" : "cursor-agent"} -p --output-format text --model composer-2.5${suffix}`;
    default:
      if (isAlibabaNonChatCapability(model)) {
        return `${displayBridgeModel(model)} is Coming soon`;
      }
      if (isAlibabaChatModel(model) || model.startsWith("qwen")) {
        return `qwen ${alibabaQwenArgv(model).join(" ")} --prompt "<task>" --output-format stream-json${suffix}`;
      }
      return `${displayBridgeModel(model)} bridge route`;
  }
}

function bridgeLogFile(_model: BrokerModel): string | undefined {
  // stderr is bounded in memory below. Persisting an unactionable log creates
  // a secret-bearing artefact and complicates cancellation cleanup.
  return undefined;
}

/**
 * Claude exposes an explicit knob for its default-system cache. Other native
 * providers cache their stable prompt prefix automatically; their installed
 * CLIs expose no equivalent safe argv option, so Cukii never fakes one.
 */
export function nativePromptCacheArgs(model: BrokerModel): string[] {
  return isClaudeNativeModel(model)
    ? ["--exclude-dynamic-system-prompt-sections"]
    : [];
}

// Anthropic documents this JSONL envelope for `-p --input-format stream-json`
// (Claude Code SDK, "Streaming JSON input"). Keeping stdin open is required
// for its realtime multi-turn transport; it is closed only on CLI completion
// or cancellation below.
/**
 * Claude's streaming input accepts the same text/image blocks that the GUI
 * stores. Reject an unsupported image before writing any part of its follow-up
 * so a live steer is always delivered whole or deferred whole.
 */
export function claudeStreamingInput(content: MessageContent): string {
  const parts =
    typeof content === "string"
      ? [{ type: "text" as const, text: content }]
      : content;
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: parts.map((part) => {
        if (part.type === "text") return part;
        const parsed = parseSupportedVisionDataUrl(part.imageUrl.url);
        if (!parsed) {
          throw new Error(
            "Claude accepts only JPEG, PNG, GIF, or WebP data-URL image attachments. Cukii did not drop the unsupported image.",
          );
        }
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mimeType,
            data: parsed.data,
          },
        };
      }),
    },
  })}\n`;
}

/**
 * The cold-start prompt is a single text blob, but Claude's streaming input
 * accepts native image blocks. Re-attach the current turn's data-URL images
 * so the vendor sees them with vision instead of only as materialized file
 * paths in the transcript. Older turns stay text-only to keep the envelope
 * bounded; remote (non data-URL) images stay materialized paths as well.
 */
export function claudeInitialContent(
  prompt: string,
  messages: ChatMessage[],
): MessageContent {
  const parts: MessageContent = [{ type: "text", text: prompt }];
  let lastUser: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      lastUser = messages[index];
      break;
    }
  }
  if (lastUser && typeof lastUser.content !== "string") {
    for (const part of lastUser.content) {
      if (part.type === "imageUrl") {
        const url = part.imageUrl?.url;
        const parsed = parseSupportedVisionDataUrl(url);
        if (parsed) {
          parts.push(part);
        } else if (/^data:image\//i.test(url ?? "")) {
          throw new Error(
            "Claude accepts only JPEG, PNG, GIF, or WebP data-URL image attachments. Cukii did not drop the unsupported image.",
          );
        }
      }
    }
  }
  return parts;
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
    // command-line budget than the native Grok executable. The shared list puts
    // the native Grok executable first for exactly that reason.
    ...windowsVendorCliCandidates(program, home),
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

function kimiWindowsNativeProgram(): string {
  const home = os.homedir();
  // The home directory itself may legitimately be redirected by Windows. The
  // trust boundary starts at its Kimi-owned child components.
  const kimiRoot = path.join(home, ".kimi-code");
  const binDirectory = path.join(kimiRoot, "bin");
  const nativeProgram = path.join(binDirectory, "kimi.exe");
  const components: Array<{ path: string; type: "directory" | "file" }> = [
    { path: kimiRoot, type: "directory" },
    { path: binDirectory, type: "directory" },
    { path: nativeProgram, type: "file" },
  ];
  try {
    for (const component of components) {
      const stats = fs.lstatSync(component.path);
      const typeMatches =
        component.type === "directory" ? stats.isDirectory() : stats.isFile();
      if (stats.isSymbolicLink() || !typeMatches) {
        throw new Error("unsafe Kimi native path component");
      }
    }
  } catch {
    throw new Error(
      `Kimi native executable is required at ${nativeProgram}; PATH and shell shims are refused.`,
    );
  }
  return nativeProgram;
}

function kimiRoute(
  label: string,
  prompt: string,
  tailArgs: string[],
): BridgeRoute {
  // Resolve the official native executable, then account for the executable,
  // every final argument, and libuv-style Windows escaping before any broker,
  // child process, or filesystem artefact can be created.
  const command =
    process.platform === "win32"
      ? {
          program: kimiWindowsNativeProgram(),
          args: ["-p", prompt, ...tailArgs],
        }
      : resolveCommand(kimiCliProgram(), ["-p", prompt, ...tailArgs]);
  let promptFile: string | undefined;
  if (
    process.platform === "win32" &&
    windowsCommandLineUtf16Length(command.program, command.args) >
      KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16
  ) {
    // Большой транскрипт не проходит в argv; содержимое уходит в эксклюзивный
    // файл под защищённым Scratch-рутом, а в `-p` остаётся короткий загрузчик.
    promptFile = writeBridgeScratchFile("kimi-transcript", prompt);
    command.args = ["-p", kimiSpillLoaderPrompt(promptFile), ...tailArgs];
  }
  try {
    assertKimiWindowsCommandLine(command.program, command.args);
  } catch (error) {
    if (promptFile) removeBridgeScratchFile(promptFile);
    throw error;
  }
  return {
    label,
    program: command.program,
    args: command.args,
    format: "kimi-ndjson",
    noStdin: true,
    ...(promptFile ? { promptFile } : {}),
  };
}

function grokRoute(
  label: string,
  nativeModel: string,
  cwd: string,
  prompt: string,
  messages: ChatMessage[],
  controls: BridgeControlResolution,
  permissionArgs: string[],
  logFile: string | undefined,
): BridgeRoute {
  const promptFile = writeBridgeScratchFile("grok-transcript", prompt);
  try {
    const promptJson = grokPromptJson(messages, promptFile);
    const args = [
      "--model",
      nativeModel,
      ...grokControlArgs(controls),
      ...permissionArgs,
      "--cwd",
      cwd,
      "--prompt-json",
      promptJson,
      "--output-format",
      "streaming-messages-json",
    ];
    assertGrokWindowsCommandLine("grok", args);
    return {
      label,
      program: "grok",
      args,
      format: "anthropic-envelope",
      promptFile,
      logFile,
    };
  } catch (error) {
    removeBridgeScratchFile(promptFile);
    throw error;
  }
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

  const storage = resolveBridgeStorageLayout({ pathExists: fs.existsSync });
  const inheritedEnv =
    process.platform === "win32"
      ? removeCaseInsensitiveEnvKeys(process.env, ["npm_config_store_dir"])
      : process.env;
  if (process.platform === "win32") {
    fs.mkdirSync(storage.tempDir, { recursive: true });
  }
  const env: BridgeEnv = {
    ...inheritedEnv,
    [pathKey]: segments.join(path.delimiter),
    ...(process.platform === "win32" ? { ComSpec: windowsCmdPath() } : {}),
    CUKII_BRIDGE_MODE: "broker",
    CUKII_BROKER_MODEL: model,
    CUKII_SUBAGENT_MODEL: subagent,
    ...(process.platform === "win32"
      ? {
          TEMP: storage.tempDir,
          TMP: storage.tempDir,
          TMPDIR: storage.tempDir,
          ...(storage.pnpmStoreDir
            ? { npm_config_store_dir: storage.pnpmStoreDir }
            : {}),
        }
      : {}),
  };

  // Kimi аутентифицируется собственным device-токеном (`kimi login`), а не через
  // ANTHROPIC_*-переменные — специальная env-обвязка ему не нужна.

  return env;
}

function ensureProgramAvailable(route: BridgeRoute): ResolvedCommand {
  const probeCommand = resolveCommand(route.program, ["--version"]);
  const probe = childProcess.spawnSync(
    probeCommand.program,
    probeCommand.args,
    {
      encoding: "utf8",
      env: bridgeEnv("fable-5", "auto"),
      shell: false,
      windowsHide: true,
    },
  );
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
  permissionMode: CukiiPermissionMode = "bypass",
): BridgeRoute {
  const logFile = bridgeLogFile(model);
  // There is no executable DeepSeek route yet.  Do this before resolving a
  // permission capability, otherwise a missing capability would disguise the
  // deliberate transport error below.
  if (model === "deepseek-v4-pro") {
    throw new Error("DeepSeek bridge is not connected yet");
  }
  if (isAlibabaNonChatCapability(model)) {
    throw new Error(`${displayBridgeModel(model)} is Coming soon`);
  }
  const permissionArgs = permissionControlArgs(model, permissionMode);
  const claudeModel = {
    "opus-5": "claude-opus-5",
    "sonnet-5": "claude-sonnet-5",
    "fable-5": "claude-fable-5",
    "fable-5-1": "claude-fable-5-1",
    "haiku-4-5": "claude-haiku-4-5",
  }[model];
  if (claudeModel) {
    return {
      label: displayBridgeModel(model),
      program: claudeProgram(),
      args: [
        "--model",
        claudeModel,
        ...nativePromptCacheArgs(model),
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
    return grokRoute(
      displayBridgeModel(model),
      nativeGrokModel,
      cwd,
      prompt,
      messages,
      controls,
      permissionArgs,
      logFile,
    );
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
    const skillDirs = getKimiSkillDirs();
    return kimiRoute(displayBridgeModel(model), prompt, [
      "--output-format",
      "stream-json",
      "-m",
      liveKimiModel,
      ...permissionArgs,
      ...skillDirs.flatMap((dir) => ["--skills-dir", dir]),
    ]);
  }
  switch (model) {
    // `--verbose` обязателен: без него `claude -p` не отдаёт stream-json.
    case "opus-5":
      return {
        label: displayBridgeModel(model),
        program: claudeProgram(),
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
        program: claudeProgram(),
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
    case "fable-5-1":
      return {
        label: displayBridgeModel(model),
        program: claudeProgram(),
        args: [
          "--model",
          "claude-fable-5-1",
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
        program: claudeProgram(),
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
    // `-p` берёт промпт аргументом и stdin не читает; транскрипт, не проходящий
    // в Windows command-line лимит, уходит в эксклюзивный Scratch-файл, который
    // агент читает первым действием (см. kimiRoute).
    case "kimi-k2":
    case "kimi-k2-highspeed":
    case "kimi-k3":
    case "kimi-k3-256k": {
      const modelArg = kimiNativeModel(model);
      const skillDirs = getKimiSkillDirs();
      return kimiRoute(displayBridgeModel(model), prompt, [
        "--output-format",
        "stream-json",
        ...(modelArg ? ["-m", modelArg] : []),
        ...permissionArgs,
        ...skillDirs.flatMap((dir) => ["--skills-dir", dir]),
      ]);
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
      return grokRoute(
        displayBridgeModel(model),
        "grok-4.6",
        cwd,
        prompt,
        messages,
        controls,
        permissionArgs,
        logFile,
      );
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
    default:
      if (isAlibabaChatModel(model) || model.startsWith("qwen")) {
        return {
          label: displayBridgeModel(model),
          program: "qwen",
          args: [
            ...alibabaQwenArgv(model),
            "--safe-mode",
            "--prompt",
            "Follow the Cukii broker instructions supplied on stdin.",
            "--output-format",
            "stream-json",
            ...permissionArgs,
          ],
          // Qwen Code compatible-mode stream-json follows the assistant/user/result
          // envelope consumed by the same parser as Claude and Grok.
          format: "anthropic-envelope",
          logFile,
        };
      }
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
type BridgeTerminalChatMessage = ChatMessage & { cukiiTerminal?: true };

export function isBridgeTerminalChatMessage(
  message: ChatMessage,
): message is BridgeTerminalChatMessage {
  return (message as BridgeTerminalChatMessage).cukiiTerminal === true;
}

/** Explicit bridge-only transport metadata, never text that a model can emit. */
export type CukiiBridgeWait = {
  condition: string;
  deadline?: string;
};

export type CukiiBridgeChatMessage = ChatMessage & {
  cukiiBridgeWait?: CukiiBridgeWait;
  cukiiTerminal?: true;
  /** A definitive native error receipt, not model-authored transcript text. */
  cukiiTerminalError?: true;
  /** Exact follow-up that the native vendor echoed as input. */
  cukiiSteerReadMessageId?: string;
  /** Structured vendor activity proving that this turn accepted its input. */
  cukiiVendorActivity?: true;
};

/**
 * Raw stdout is not an input receipt: native CLIs can print startup/auth/quota
 * failures before a model sees the prompt. Only a parsed model/tool event (or
 * a clean terminal receipt with no failure in the same frame) proves that the
 * restored batch crossed the vendor boundary.
 */
export function bridgeEventsProveInputAccepted(
  events: BridgeEvent[],
  priorFailure = false,
): boolean {
  const hasFailure =
    priorFailure ||
    events.some(
      (event) => event.kind === "error" || event.kind === "terminalError",
    );
  return events.some((event) => {
    switch (event.kind) {
      case "text":
      case "userEcho":
      case "thinking":
      case "toolStart":
      case "toolResult":
      case "wait":
        return true;
      case "complete":
        return !hasFailure;
      case "steerRead":
      case "error":
      case "terminalError":
        return false;
    }
  });
}

/**
 * A native protocol receipt settles the turn even when Cukii must terminate a
 * CLI that lingers after emitting it. The resulting non-zero process code is
 * teardown metadata, not a second vendor outcome.
 */
export function bridgeProcessExitIsFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  protocolTerminalReceived: boolean,
  terminalReceiptRequired = false,
): boolean {
  return (
    !protocolTerminalReceived &&
    (code !== 0 || signal !== null || terminalReceiptRequired)
  );
}

/**
 * A child that has actually stopped cannot continue producing a response.
 * Surface that fact in the transcript as a terminal receipt so the GUI both
 * explains the interruption and releases the composer. A normal protocol
 * terminal or an explicit user cancellation remains authoritative and quiet.
 */
export function bridgeProcessFailureTerminalEvent(
  error: Error | undefined,
  cancelled: boolean,
  protocolTerminalReceived: boolean,
): Extract<BridgeEvent, { kind: "terminalError" }> | undefined {
  if (!error || cancelled || protocolTerminalReceived) return undefined;
  return { kind: "terminalError", text: error.message };
}

interface BridgeProcessFailureMessageArgs {
  label: string;
  detail: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  logFile?: string;
}

/**
 * Turn a noisy native stderr/stdout tail into one actionable terminal receipt.
 * The transport log remains available on disk, but protocol JSON and completed
 * tool output must never be pasted into the conversation as the error message.
 */
export function bridgeProcessFailureMessage({
  label,
  detail,
  code,
  signal,
  logFile,
}: BridgeProcessFailureMessageArgs): string {
  const logSuffix = logFile ? ` Bridge log: ${logFile}` : "";
  const creditFailure = /out of credits|refill/i.test(detail);
  const policyFailure =
    /Rejected\(|blocked by (?:the )?(?:local )?(?:safety )?policy/i.test(
      detail,
    );
  const capacityFailure = detail.match(
    /Selected model is at capacity(?:\. Please try a different model\.)?/i,
  );
  const cacheField = detail.match(
    /failed to load models cache: missing field `([^`]+)`/,
  );

  if (policyFailure) {
    return (
      `${label} stopped because the local safety policy blocked a command. The blocked command was not executed. Send the message again to continue in a fresh turn.` +
      logSuffix
    );
  }
  if (creditFailure) {
    return (
      `${label} bridge stopped because the vendor workspace is out of credits. This is a usage limit, not a Cukii defect: ask the workspace owner to refill credits, then send the message again.` +
      logSuffix
    );
  }
  if (capacityFailure) {
    return (
      `${label} is temporarily at capacity. Choose another model or send the message again.` +
      logSuffix
    );
  }
  if (cacheField) {
    return (
      `${label} bridge could not start: the Codex models cache is missing the field "${cacheField[1]}". This is a cache incompatibility, not a usage limit. Cukii repairs known fields before the next launch; if it repeats, delete ~/.codex/models_cache.json so the CLI fetches a fresh one.` +
      logSuffix
    );
  }
  return (
    `${label} bridge exited ${
      signal ? `after signal ${signal}` : `with code ${code}`
    }.` +
    (detail
      ? ` ${detail}`
      : " Native CLI stopped before returning a normal response.") +
    logSuffix
  );
}

export type BridgeChildErrorSettlement = {
  events: BridgeEvent[];
  error: Error | undefined;
  protocolTerminalReceived: boolean;
};

/**
 * `error` may arrive while the final NDJSON receipt is still buffered because
 * it had no trailing newline. Flush before settling the process outcome: an
 * explicit protocol terminal is authoritative, while a genuine spawn/stream
 * error without such a receipt remains fatal.
 */
export function settleBridgeChildError(
  parser: Pick<BridgeEventParser, "flush">,
  childError: Error,
  priorProtocolTerminalReceived: boolean,
): BridgeChildErrorSettlement {
  const events = parser.flush();
  const protocolTerminalReceived =
    priorProtocolTerminalReceived ||
    events.some((event) => event.kind === "complete");
  return {
    events,
    error: protocolTerminalReceived ? undefined : childError,
    protocolTerminalReceived,
  };
}

export function toChatMessages(event: BridgeEvent): CukiiBridgeChatMessage[] {
  switch (event.kind) {
    case "text":
      return [{ role: "assistant", content: event.text }];
    case "userEcho":
      return [];
    case "steerRead":
      return [
        {
          role: "thinking",
          content: "",
          cukiiSteerReadMessageId: event.messageId,
        },
      ];
    case "thinking":
      return [
        {
          role: "thinking",
          content: event.text,
          ...(event.vendorActivity ? { cukiiVendorActivity: true } : {}),
        },
      ];
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
    case "wait":
      return [
        {
          role: "thinking",
          content: "",
          cukiiBridgeWait: {
            condition: event.condition,
            deadline:
              event.durationSeconds === undefined
                ? undefined
                : new Date(
                    Date.now() + event.durationSeconds * 1_000,
                  ).toISOString(),
          },
        },
      ] as CukiiBridgeChatMessage[];
    case "error":
      return [{ role: "assistant", content: `\n\n⚠️ ${event.text}\n` }];
    case "terminalError":
      return [
        {
          role: "assistant",
          content: `\n\n⚠️ ${event.text}\n`,
          cukiiTerminalError: true,
        },
      ];
    case "complete":
      // Keep terminal state on the stream transport rather than in transcript
      // history. The GUI consumes this private marker and hides activity
      // before waiting for a tardy native process close.
      return [
        { role: "assistant", content: "", cukiiTerminal: true },
      ] as CukiiBridgeChatMessage[];
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
    brokerAutocompact?: BrokerAutocompact;
    thinkingEnabled: boolean;
    brokerPermissionMode: CukiiPermissionMode;
    queuedFollowUpMessageId?: string;
    queuedFollowUpMessageIds?: string[];
    steerInterrupt?: boolean;
  },
  permissionTransport?: ClaudePermissionTransport,
): AsyncGenerator<ChatMessage, PromptLog> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();
  const imageScope = permissionTransport?.imageScope ?? new BridgeImageScope();
  const ownsImageScope = !permissionTransport?.imageScope;
  try {
    return yield* streamBridgeChatWithSteer(
      args,
      cwd,
      imageScope,
      permissionTransport,
    );
  } finally {
    if (ownsImageScope) imageScope.dispose();
  }
}

async function* streamBridgeChatWithSteer(
  args: {
    sessionId: string;
    messages: ChatMessage[];
    brokerModel: BrokerModel;
    brokerSubagent: BrokerSubagent;
    brokerEffort: BrokerEffort;
    brokerSpeed: BrokerSpeed;
    brokerAutocompact?: BrokerAutocompact;
    thinkingEnabled: boolean;
    brokerPermissionMode: CukiiPermissionMode;
    queuedFollowUpMessageId?: string;
    queuedFollowUpMessageIds?: string[];
    steerInterrupt?: boolean;
  },
  cwd: string,
  imageScope: BridgeImageScope,
  permissionTransport?: ClaudePermissionTransport,
): AsyncGenerator<ChatMessage, PromptLog> {
  // The model picker fills this cache in the normal path. A restored saved
  // session may send before that picker opens, so rebuild it on demand.
  await ensureCursorCatalogVariants(args.brokerModel);
  const permissionVendors = new Set([
    brokerVendorForModel(args.brokerModel),
    ...(args.brokerSubagent === "auto"
      ? []
      : [brokerVendorForModel(args.brokerSubagent)]),
  ]);
  await Promise.all(
    [...permissionVendors].map((vendor) =>
      vendorPermissionCapabilities(vendor),
    ),
  );
  const controls = resolveBridgeControls(
    args.brokerModel,
    args.brokerEffort,
    args.brokerSpeed,
    args.thinkingEnabled,
    args.brokerAutocompact,
  );
  const transportMessages = selectBridgeImageSources(
    args.messages,
    args.brokerModel,
  );
  const prompt = buildPrompt(
    imageScope.materializeMessages(transportMessages),
    args.brokerModel,
    args.brokerSubagent,
    cwd,
    controls,
    args.brokerPermissionMode,
    hasImageAttachment(transportMessages),
    args.steerInterrupt,
  );
  const route = routeForModel(
    args.brokerModel,
    cwd,
    prompt,
    transportMessages,
    controls,
    args.brokerPermissionMode,
  );
  // The harness canary is deliberately limited to Kimi.  It carries a nonce
  // from the exact submitted user turn and emits no record for normal chats.
  const canaryTurn = runtimeCanaryTurn(args.messages);
  const activeExtension = vscode.extensions.getExtension("cukii.cukii-vscode");
  const extensionBinding = activeExtension
    ? runtimeCanaryExtensionBinding(
        activeExtension.extensionPath,
        activeExtension.packageJSON.version,
      )
    : undefined;
  const canary =
    canaryTurn && args.brokerModel.startsWith("kimi") && extensionBinding
      ? new RuntimeCanaryAttestation(
          canaryTurn,
          args.brokerModel,
          extensionBinding,
          permissionTransport?.onRuntimeCanaryEvent,
        )
      : undefined;
  let permissionBroker: ClaudePermissionBroker | undefined;
  if (
    ["opus-5", "sonnet-5", "fable-5", "fable-5-1", "haiku-4-5"].includes(
      args.brokerModel,
    ) &&
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
      onPendingChanged: permissionTransport.onPendingChanged,
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
    if (brokerVendorForModel(args.brokerModel) === "grok") {
      // `resolveCommand` can replace the short `grok` token with an absolute
      // native path (or a cmd shim plus prefix args). The last pre-spawn check
      // must therefore measure that fully resolved Windows command line.
      assertGrokWindowsCommandLine(command.program, command.args);
    }
  } catch (err) {
    if (route.promptFile) removeBridgeScratchFile(route.promptFile);
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

  // A codex startup crash caused by its models cache is repaired and the
  // launch retried exactly once; every other failure surfaces untouched.
  const launchOptions = {
    command,
    route,
    cwd,
    prompt,
    messages: transportMessages,
    sessionId: args.sessionId,
    brokerModel: args.brokerModel,
    brokerSubagent: args.brokerSubagent,
    queuedFollowUpMessageId: args.queuedFollowUpMessageId,
    queuedFollowUpMessageIds: args.queuedFollowUpMessageIds,
    permissionTransport,
    canary,
    permissionBroker,
  };
  let codexCacheRetried = false;
  for (;;) {
    try {
      return yield* launchBridgeChild(launchOptions);
    } catch (err) {
      const failureMessage = err instanceof Error ? err.message : String(err);
      if (
        route.program !== "codex" ||
        !isCodexModelsCacheFailure(failureMessage)
      ) {
        throw err;
      }
      if (codexCacheRetried) {
        throw new Error(
          `${route.label} bridge still cannot start after a cache repair: the Codex CLI keeps rejecting ${path.join(resolveCodexHome(), "models_cache.json")}. Another installed Codex/ChatGPT extension shares that file and rewrites it without \`supports_parallel_tool_calls\`. Update that extension or delete the cache file, then retry. (${failureMessage})`,
        );
      }
      codexCacheRetried = true;
      yield {
        role: "thinking",
        content:
          "Codex rejected its models cache at launch; Cukii healed the file and retries the bridge once.\n",
      };
    }
  }
}

/**
 * One full bridge child lifecycle: spawn, stream, and teardown. Heals the
 * shared codex models cache immediately before the spawn so a stale writer
 * (another installed Codex/ChatGPT extension) cannot strand the launch.
 */
async function* launchBridgeChild(options: {
  command: ResolvedCommand;
  route: BridgeRoute;
  cwd: string;
  prompt: string;
  messages: ChatMessage[];
  sessionId?: string;
  brokerModel: BrokerModel;
  brokerSubagent: BrokerSubagent;
  queuedFollowUpMessageId?: string;
  queuedFollowUpMessageIds?: string[];
  permissionTransport?: ClaudePermissionTransport;
  canary?: RuntimeCanaryAttestation;
  permissionBroker?: ClaudePermissionBroker;
}): AsyncGenerator<ChatMessage, PromptLog> {
  const {
    command,
    route,
    cwd,
    prompt,
    messages,
    sessionId,
    brokerModel,
    brokerSubagent,
    queuedFollowUpMessageId,
    queuedFollowUpMessageIds = queuedFollowUpMessageId
      ? [queuedFollowUpMessageId]
      : [],
    permissionTransport,
    canary,
    permissionBroker,
  } = options;
  if (
    brokerVendorForModel(brokerModel) === "codex" ||
    (brokerSubagent !== "auto" &&
      brokerVendorForModel(brokerSubagent) === "codex")
  ) {
    // Another installed Codex/ChatGPT extension shares CODEX_HOME and keeps
    // rewriting the models cache without `supports_parallel_tool_calls`; heal
    // right before the spawn so Sol/Terra never exit with code 1 at startup.
    ensureCodexModelsCacheCompatible();
  }
  // Idempotent, fail-open wiring of the broker inbox channel for the vendor
  // about to spawn (MCP registration + strict delivery gate). Failures only
  // degrade to the turn-end drain fallback.
  ensureBrokerVendorIntegration(brokerModel);
  const child = childProcess.spawn(command.program, command.args, {
    cwd,
    env: {
      ...bridgeEnv(brokerModel, brokerSubagent),
      ...(await alibabaSpawnEnv(brokerModel)),
      // Kept for vendors that preserve inherited env. The authoritative MCP
      // binding is the pid + process-start-token record registered below.
      ...(sessionId ? { CUKII_SESSION_ID: sessionId } : {}),
    },
    shell: false,
    windowsHide: true,
  });
  if (child.pid && sessionId) {
    registerBrokerSessionBinding(
      child.pid,
      sessionId,
      queuedFollowUpMessageIds,
    );
  }
  // The pid is the only handle a dispose-time retry has when the primary
  // teardown could not verify death. Report it before any await can race it.
  permissionTransport?.onChildSpawned?.(child.pid);
  canary?.record("bridge_dispatch");
  let cancelled = false;
  let done = false;
  let protocolTerminalReceived = false;
  const queue: BridgeEvent[] = [];
  let canaryResponse = "";
  const queuedFollowUpRead = new Set<string>();
  const enqueueVisibleEvents = (events: BridgeEvent[]) => {
    for (const event of events) {
      if (event.kind === "complete") {
        // The child can close before the generator drains this queue. Record
        // the receipt at parse time so teardown cannot overwrite the turn.
        protocolTerminalReceived = true;
      }
      if (event.kind === "userEcho") {
        const queuedMessageId = queuedFollowUpEchoMessageId(
          messages,
          queuedFollowUpMessageIds,
          event.text,
          queuedFollowUpRead,
        );
        if (queuedMessageId && queuedFollowUpRead.has(queuedMessageId)) {
          // Structured vendor activity already acknowledged this exact batch
          // member. Its later echo is private transport noise, never a second
          // user turn.
          continue;
        }
        const messageId = queuedMessageId
          ? queuedMessageId
          : permissionTransport?.steering?.consumeVendorEcho(event.text);
        if (messageId) {
          if (queuedMessageId) queuedFollowUpRead.add(queuedMessageId);
          queue.push({ kind: "steerRead", messageId });
        } else {
          // Existing non-meta `user` frames (for example human hook text)
          // stay visible exactly as before; only an exact pending follow-up
          // becomes private receipt transport.
          queue.push({ kind: "text", text: event.text });
        }
        continue;
      }
      if (event.kind === "toolStart") {
        permissionTransport?.onToolActivity?.({ kind: "start", id: event.id });
      }
      if (event.kind === "toolResult") {
        permissionTransport?.onToolActivity?.({ kind: "finish", id: event.id });
      }
      if (event.kind === "text") {
        canaryResponse += event.text;
      }
      queue.push(event);
    }
  };
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
  let inputAccepted = false;
  let inputFailureObserved = false;

  if (!route.noStdin && !cancelled) {
    child.stdin.write(
      route.stdinFormat === "claude-stream-json"
        ? claudeStreamingInput(claudeInitialContent(prompt, messages))
        : prompt,
    );
    if (!route.stdinFormat) child.stdin.end();
    if (route.stdinFormat === "claude-stream-json") {
      permissionTransport?.steering?.attachWriter(async (message) => {
        if (
          child.exitCode !== null ||
          child.signalCode !== null ||
          permissionTransport?.abortSignal?.aborted
        ) {
          return false;
        }
        return new Promise<boolean>((resolve) => {
          child.stdin.write(claudeStreamingInput(message.content), (error) => {
            const written = !error;
            if (
              written &&
              permissionTransport?.steering?.acknowledgeWritten(
                message.messageId,
              )
            ) {
              // Claude accepts the envelope but never echoes it, so the
              // echo-based receipt would never fire for this vendor.
              queue.push({ kind: "steerRead", messageId: message.messageId });
            }
            resolve(written);
          });
        });
      });
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
    if (
      !inputAccepted &&
      bridgeEventsProveInputAccepted(events, inputFailureObserved)
    ) {
      inputAccepted = true;
      if (sessionId && queuedFollowUpMessageIds.length > 0) {
        const acked = new Set(
          markBridgeInboxMessagesRead(sessionId, queuedFollowUpMessageIds),
        );
        for (const messageId of queuedFollowUpMessageIds) {
          const status = bridgeInboxMessageStatus(sessionId, messageId);
          // A pending file that failed atomic replacement must stay at one
          // checkmark and be replayed. Absent/already-read files are safe:
          // the exact message is present in the persisted chat timeline.
          if (
            !acked.has(messageId) &&
            status !== "read" &&
            status !== "absent"
          ) {
            continue;
          }
          if (queuedFollowUpRead.has(messageId)) continue;
          queuedFollowUpRead.add(messageId);
          queue.push({ kind: "steerRead", messageId });
        }
      }
      // The GUI upgrades the ordinary current message only on this private
      // structured acceptance event, never on arbitrary stdout bytes.
      queue.push({ kind: "thinking", text: "", vendorActivity: true });
    }
    inputFailureObserved ||= events.some(
      (event) => event.kind === "error" || event.kind === "terminalError",
    );
    enqueueVisibleEvents(events);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    if (route.logFile) fs.appendFileSync(route.logFile, text, "utf8");
  });
  child.once("error", (err) => {
    if (cancelled) return;
    const settlement = settleBridgeChildError(
      parser,
      err,
      protocolTerminalReceived,
    );
    enqueueVisibleEvents(settlement.events);
    protocolTerminalReceived = settlement.protocolTerminalReceived;
    error = settlement.error;
    done = true;
  });
  child.once("close", (code, signal) => {
    child.stdin.end();
    if (cancelled) {
      done = true;
      return;
    }
    enqueueVisibleEvents(parser.flush());
    if (
      !cancelled &&
      bridgeProcessExitIsFailure(
        code,
        signal,
        protocolTerminalReceived,
        route.stdinFormat === "claude-stream-json" ||
          route.format === "codex-thread",
      )
    ) {
      const detail = stderr.trim() || stdoutTail.trim();
      error = new Error(
        bridgeProcessFailureMessage({
          label: route.label,
          detail,
          code,
          signal,
          logFile: route.logFile,
        }),
      );
    }
    if (!cancelled) {
      canary?.record("vendor_completed", {
        result: runtimeCanaryResult(code, rawStdout, stderr),
        exit_code: code,
        ...runtimeCanaryResponseSummary(canaryResponse || rawStdout),
      });
    }
    done = true;
  });

  // Потребитель может бросить генератор на середине (кнопка Stop в чате). Без
  // finally дочерний CLI оставался жить: он дописывал ответ в никуда, продолжал
  // тратить токены и мог править файлы уже после того, как пользователь остановил
  // ответ. Полная отмена требует ещё и проброса AbortSignal через протокол —
  // здесь закрыт только гарантированный процессный хвост.
  try {
    let terminalReceived = false;
    while (!done || queue.length) {
      const next = queue.shift();
      if (next) {
        if (next.kind === "text") {
          completion += next.text;
        }
        if (next.kind !== "complete") {
          registerNestedWorkerFollower(next, toolNamesById, followers);
        }
        for (const message of toChatMessages(next)) {
          yield message;
        }
        if (next.kind === "complete") {
          // The protocol's own final receipt is authoritative. Do not wait
          // for a child that lingers after printing its completed turn.
          terminalReceived = true;
          break;
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
    if (!terminalReceived) {
      for (const message of drainFollowers(followers)) {
        yield message;
      }
    }
    if (
      !terminalReceived &&
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
    let terminated = false;
    try {
      terminated = await terminateBridgeChild(child);
    } catch {
      terminated = false;
    }
    permissionTransport?.onTerminationResult?.(terminated);
    if (route.promptFile) removeBridgeScratchFile(route.promptFile);
    if (permissionBroker) {
      await permissionBroker.dispose();
      permissionTransport?.onBrokerDisposed?.(permissionBroker);
    }
    if (!terminated) {
      throw new Error(
        "Native bridge process tree did not terminate within the safety budget",
      );
    }
  }

  const terminalFailure = bridgeProcessFailureTerminalEvent(
    error,
    cancelled,
    protocolTerminalReceived,
  );
  if (terminalFailure) {
    for (const message of toChatMessages(terminalFailure)) {
      yield message;
    }
  }

  return {
    modelTitle: route.label,
    modelProvider: "cukii-bridge",
    prompt,
    completion,
  };
}
