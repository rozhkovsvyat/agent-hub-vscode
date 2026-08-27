import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ChatMessage, PromptLog } from "core";
import type { BrokerModel, BrokerSubagent } from "core/protocol/ideWebview";
import * as vscode from "vscode";

import { BridgeEvent, BridgeEventParser, BridgeFormat } from "./bridgeEvents";
import { describeBridgeLaunch, grokPromptJson } from "./grokPrompt";
import { buildBridgeTranscript } from "./bridgeTranscript";
import {
  closeFollowers,
  drainFollowers,
  registerNestedWorkerFollower,
  type NestedWorkerFollower,
} from "./nestedWorkerFollow";
import {
  beginSteerSession,
  endSteerSession,
  steerPromptInstruction,
} from "./bridgeSteer";

type BridgeRoute = {
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
};

type ResolvedCommand = {
  program: string;
  args: string[];
};

type BridgeEnv = NodeJS.ProcessEnv;

const MODEL_LABELS: Record<BrokerModel, string> = {
  "opus-5": "Opus 5",
  "sonnet-5": "Sonnet 5",
  "fable-5": "Fable 5",
  "codex-5-6-terra": "Codex 5.6 Terra",
  "codex-5-6-sol": "Codex 5.6 Sol",
  "grok-4-6": "Grok 4.6",
  "composer-2-5": "Composer 2.5",
  // Enum id остаётся kimi-k2 ради совместимости с persist'ом globalState.
  // Дефолт подписки — kimi-code/kimi-for-coding (K2.7 Coding), поэтому витрина —
  // «Kimi K2.7». K3 у подписки тоже есть (kimi-code/k3).
  "kimi-k2": "Kimi K2.7",
  "kimi-k3": "Kimi K3",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
};

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

function kimiModelOverride(): string | undefined {
  const m = process.env.CUKII_KIMI_MODEL || process.env.MOONSHOT_MODEL;
  return m && m.trim() ? m.trim() : undefined;
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
  steerPath: string,
): string {
  const subagent =
    brokerSubagent === "auto" ? "Auto" : MODEL_LABELS[brokerSubagent];
  const selectedSubagentGuidance =
    brokerSubagent === "auto"
      ? "Subagent routing is Auto: choose the strongest appropriate native worker and say which one you chose."
      : [
          `Subagent routing is locked to ${MODEL_LABELS[brokerSubagent]}.`,
          "If the user asks you to delegate, you MUST use that selected native worker.",
          "Do not use Claude Code's built-in Agent/Explore/Task subagent as a substitute for a selected Cukii subagent.",
          "If the selected native worker cannot be launched, report that failure explicitly instead of silently falling back.",
          // Раньше здесь была только shell-подсказка, поэтому делегирование
          // зависело от того, догадается ли модель вызвать инструмент. Называем
          // оба пути и правило выбора между ними явно.
          "Two delegation mechanisms exist; pick by where the work lives.",
          "(1) Work inside a Cukii vault scope (work, fm, housing, agents, hub):" +
            ` call mcp__cukii-broker__broker_delegate with agent="${brokerAgentId(brokerSubagent)}",` +
            ` model="${MODEL_LABELS[brokerSubagent]}" and an EXPLICIT scope argument,` +
            " then poll broker_status and finish with broker_accept." +
            " The scope argument is mandatory unless the task text names the scope itself:" +
            " without it routing cannot resolve and delegation is refused.",
          `(2) Work outside those vault roots — including this workspace at ${cwd} —` +
            " is not routable by the broker: run the native CLI yourself instead:" +
            ` ${nativeDelegateHint(brokerSubagent, cwd)}`,
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
    `Broker model: ${MODEL_LABELS[brokerModel]}.`,
    `Preferred subagent model: ${subagent}.`,
    selectedSubagentGuidance,
    "Use the local Codex/Claude/Grok/Cursor bridge environment and available Cukii MCP tools when delegation is useful.",
    "Answer in the user's language and keep normal chat continuity from the transcript.",
    "While working, write short status lines often — what you are doing now, not a spinner. Long silent stretches between tools read as a freeze.",
    steerPromptInstruction(steerPath),
    "",
    transcript,
  ].join("\n");
}

/** Имя worker-а в enum broker_delegate, а не витринная подпись модели. */
function brokerAgentId(
  model: BrokerModel,
): "codex" | "claude" | "grok" | "cursor" | "deepseek" {
  switch (model) {
    case "opus-5":
    case "sonnet-5":
    case "fable-5":
      return "claude";
    case "codex-5-6-terra":
    case "codex-5-6-sol":
      return "codex";
    case "grok-4-6":
      return "grok";
    case "composer-2-5":
      return "cursor";
    // Kimi едет через тот же claude CLI, поэтому worker-канал у него claude.
    case "kimi-k2":
    case "kimi-k3":
      return "claude";
    case "deepseek-v4-pro":
      return "deepseek";
  }
}

function nativeDelegateHint(model: BrokerModel, cwd: string): string {
  switch (model) {
    case "opus-5":
      return 'claude --model opus -p "<task>"';
    case "sonnet-5":
      return 'claude --model sonnet -p "<task>"';
    case "fable-5":
      return 'claude --model fable -p "<task>"';
    case "codex-5-6-terra":
      return `codex -m gpt-5.6-terra exec -s danger-full-access --cd "${cwd}" -`;
    case "codex-5-6-sol":
      return `codex -m gpt-5.6-sol exec -s danger-full-access --cd "${cwd}" -`;
    case "grok-4-6":
      return `grok --model grok-4.6 --cwd "${cwd}" --prompt-file <task-file>`;
    case "composer-2-5":
      return "cursor-agent -p --output-format text --model composer-2.5 --trust";
    case "kimi-k2":
      return 'kimi -p "<task>" --output-format stream-json';
    case "kimi-k3":
      return 'kimi -p "<task>" -m kimi-code/k3 --output-format stream-json';
    case "deepseek-v4-pro":
      return "deepseek bridge is not connected yet";
  }
}

function bridgeLogFile(model: BrokerModel): string {
  return path.join(
    os.tmpdir(),
    `cukii-${model}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
  );
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

function routeForModel(
  model: BrokerModel,
  cwd: string,
  prompt: string,
  messages: ChatMessage[],
): BridgeRoute {
  const logFile = bridgeLogFile(model);
  switch (model) {
    // `--verbose` обязателен: без него `claude -p` не отдаёт stream-json.
    case "opus-5":
      return {
        label: MODEL_LABELS[model],
        program: "claude",
        args: [
          "--model",
          "opus",
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
        label: MODEL_LABELS[model],
        program: "claude",
        args: [
          "--model",
          "fable",
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
        label: MODEL_LABELS[model],
        program: "claude",
        args: [
          "--model",
          "sonnet",
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        format: "anthropic-envelope",
        logFile,
      };
    // Kimi = подписочный CLI `kimi` (device-login), поток stream-json в формате
    // kimi-ndjson. Модель НЕ форсируем — берётся default_model из config.toml
    // (то, что реально даёт подписка); override только через CUKII_KIMI_MODEL.
    // `-p` берёт промпт аргументом и stdin не читает, поэтому большой транскрипт
    // уходит в файл, а kimi получает короткую инструкцию прочитать его тулом.
    case "kimi-k2":
    case "kimi-k3": {
      const modelArg =
        model === "kimi-k3" ? "kimi-code/k3" : kimiModelOverride();
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
        label: MODEL_LABELS[model],
        program: kimiCliProgram(),
        args: [
          "-p",
          promptArg,
          "--output-format",
          "stream-json",
          ...(modelArg ? ["-m", modelArg] : []),
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
        label: MODEL_LABELS[model],
        program: "codex",
        args: [
          "-m",
          "gpt-5.6-terra",
          "exec",
          "--json",
          "-s",
          "danger-full-access",
          "--cd",
          cwd,
          "-",
        ],
        format: "codex-thread",
        logFile,
      };
    case "codex-5-6-sol":
      return {
        label: MODEL_LABELS[model],
        program: "codex",
        args: [
          "-m",
          "gpt-5.6-sol",
          "exec",
          "--json",
          "-s",
          "danger-full-access",
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
        label: MODEL_LABELS[model],
        program: "grok",
        args: [
          "--model",
          "grok-4.6",
          "--cwd",
          cwd,
          "--prompt-json",
          promptJson,
          "--output-format",
          "streaming-messages-json",
          // The VS Code bridge is a headless process: it has no channel for
          // Grok's per-tool confirmation prompt. Without this Grok resolves
          // every terminal request as `cancelled` immediately, then the UI
          // reports a generic worker failure. Broker mode is itself the
          // explicit approval boundary for this native worker.
          "--always-approve",
        ],
        // Проверено прогоном: grok отдаёт тот же конверт, что claude stream-json.
        format: "anthropic-envelope",
        promptFile,
        logFile,
      };
    case "composer-2-5":
      if (process.platform === "win32") {
        const wslCwd = cwd
          .replace(
            /^([A-Za-z]):\\/,
            (_, drive: string) => `/mnt/${drive.toLowerCase()}/`,
          )
          .replace(/\\/g, "/");
        return {
          label: MODEL_LABELS[model],
          program: "wsl.exe",
          args: [
            "-d",
            "Ubuntu-24.04",
            "--",
            "bash",
            "-lc",
            'cd -- "$1"; exec "$HOME/.local/bin/cursor-agent" -p --output-format stream-json --stream-partial-output --model composer-2.5 --trust "$(cat)"',
            "cukii-cursor",
            wslCwd,
          ],
          // Схема снята из живого cursor-bridge прогона: Cursor отдаёт тот же
          // assistant/user envelope, плюс top-level thinking/tool_call events.
          format: "anthropic-envelope",
          logFile,
        };
      }
      return {
        label: MODEL_LABELS[model],
        program: "cursor-agent",
        args: [
          "-p",
          "--output-format",
          "stream-json",
          "--stream-partial-output",
          "--model",
          "composer-2.5",
          "--trust",
        ],
        format: "anthropic-envelope",
        logFile,
      };
    case "deepseek-v4-pro":
      throw new Error(
        "DeepSeek bridge is not connected yet. Select another model.",
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

export async function* streamBridgeChat(args: {
  messages: ChatMessage[];
  brokerModel: BrokerModel;
  brokerSubagent: BrokerSubagent;
}): AsyncGenerator<ChatMessage, PromptLog> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? process.cwd();
  const steerPath = path.join(
    os.tmpdir(),
    `cukii-steer-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  beginSteerSession(steerPath);
  try {
    return yield* streamBridgeChatWithSteer(args, cwd, steerPath);
  } finally {
    endSteerSession();
  }
}

async function* streamBridgeChatWithSteer(
  args: {
    messages: ChatMessage[];
    brokerModel: BrokerModel;
    brokerSubagent: BrokerSubagent;
  },
  cwd: string,
  steerPath: string,
): AsyncGenerator<ChatMessage, PromptLog> {
  const prompt = buildPrompt(
    args.messages,
    args.brokerModel,
    args.brokerSubagent,
    cwd,
    steerPath,
  );
  const route = routeForModel(args.brokerModel, cwd, prompt, args.messages);
  const subagentLabel =
    args.brokerSubagent === "auto" ? "Auto" : MODEL_LABELS[args.brokerSubagent];
  yield {
    role: "thinking",
    content:
      `Starting ${route.label} broker bridge.\n` +
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

  let completion = "";
  let stderr = "";
  let stdoutTail = "";
  let rawStdout = "";
  const launchedAt = Date.now();
  let firstOutputAt: number | undefined;

  if (!route.noStdin) {
    child.stdin.write(prompt);
  }
  child.stdin.end();

  const parser = new BridgeEventParser(route.format);
  const queue: BridgeEvent[] = [];
  const toolNamesById = new Map<string, string>();
  const followers: NestedWorkerFollower[] = [];
  let done = false;
  let error: Error | undefined;

  child.stdout.on("data", (chunk: Buffer) => {
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
    queue.push(...parser.push(text));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    fs.appendFileSync(route.logFile, text, "utf8");
  });
  child.once("error", (err) => {
    error = err;
    done = true;
  });
  child.once("close", (code) => {
    queue.push(...parser.flush());
    if (code && code !== 0) {
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
    closeFollowers(followers);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    if (route.promptFile) {
      fs.rmSync(route.promptFile, { force: true });
    }
  }

  if (error) {
    throw error;
  }

  return {
    modelTitle: route.label,
    modelProvider: "cukii-bridge",
    prompt,
    completion,
  };
}
