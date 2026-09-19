import type { CukiiVendorUsageWindow } from "core/protocol/ideWebview";

/**
 * Разбор структурного вывода нативных CLI в события моста.
 *
 * Схемы сняты живыми прогонами, а не взяты из документации:
 *  - `claude -p --output-format stream-json --verbose`,
 *    `grok -p --output-format streaming-messages-json` и Cursor
 *    `--output-format stream-json --stream-partial-output` дают совместимый конверт
 *    (`assistant` / `user` / `system` / `result` с блоками
 *    `thinking` | `text` | `tool_use` | `tool_result`), поэтому парсер общий;
 *  - `codex exec --json` использует другую модель — `thread.started`,
 *    `turn.*`, `item.started` / `item.completed` с типами item'ов
 *    (`command_execution`, `agent_message`, `error`, …).
 *
 * Модуль намеренно ничего не знает про ChatMessage: он переводит вендорный
 * формат в нейтральные события, а раскладку по сообщениям UI делает адаптер.
 */

export type BridgeEvent =
  | { kind: "text"; text: string }
  /** A native `user` envelope, used only as an exact input-read receipt. */
  | { kind: "userEcho"; text: string }
  /** Private bridge transport event; never rendered as transcript text. */
  | { kind: "steerRead"; messageId: string }
  | {
      kind: "thinking";
      text: string;
      /** The native CLI has emitted stdout for this turn. */
      vendorActivity?: true;
    }
  | { kind: "toolStart"; id: string; name: string; args: string }
  | { kind: "toolResult"; id: string; output: string; isError: boolean }
  /** Native subscription/rate-limit receipt; never rendered as chat text. */
  | { kind: "usage"; windows: CukiiVendorUsageWindow[] }
  | { kind: "error"; text: string }
  /** A vendor's explicit failed turn receipt; it settles the GUI run. */
  | { kind: "terminalError"; text: string }
  /** A vendor's explicit turn-complete receipt, never a guessed quiet gap. */
  | { kind: "complete" }
  /** Explicit native command wait; never inferred from missing output. */
  | { kind: "wait"; condition: string; durationSeconds?: number }
  | { kind: "error"; text: string };

export type BridgeFormat =
  | "anthropic-envelope"
  | "codex-thread"
  | "kimi-ndjson"
  | "text";

// Claude emits a blocked Stop hook as a synthetic `user` envelope. It is not
// model-authored assistant text: retrying the same blocked hook can replay the
// complete feedback after an otherwise new assistant turn.
const CLAUDE_STOP_HOOK_FEEDBACK_PREFIX = "Stop hook feedback:";
const MAX_STOP_HOOK_FEEDBACK_CACHE = 64;

function isStopHookFeedback(
  envelope: any,
  event: BridgeEvent,
): event is Extract<BridgeEvent, { kind: "text" }> {
  return (
    envelope?.type === "user" &&
    envelope?.message?.role === "user" &&
    // `isMeta` is set only on Claude's synthetic hook envelope. A human user
    // can legitimately write the same prefix, so absent/false is never folded.
    envelope?.isMeta === true &&
    event.kind === "text" &&
    event.text.startsWith(CLAUDE_STOP_HOOK_FEEDBACK_PREFIX)
  );
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        part && typeof part === "object" && "text" in (part as any)
          ? String((part as any).text ?? "")
          : typeof part === "string"
            ? part
            : JSON.stringify(part),
      )
      .join("");
  }
  if (value === undefined || value === null) {
    return "";
  }
  return JSON.stringify(value);
}

function resetEpochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000
      ? Math.round(value / 1_000)
      : Math.round(value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.round(parsed / 1_000) : undefined;
}

function usageWindow(
  id: string,
  label: string,
  value: any,
): CukiiVendorUsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw =
    value.utilization ??
    value.used_percent ??
    value.usedPercentage ??
    value.usedPercent;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const utilization = raw > 1 ? raw / 100 : raw;
  if (utilization < 0) return undefined;
  const resetsAt = resetEpochSeconds(
    value.resetsAt ?? value.resets_at ?? value.resetAt ?? value.reset_at,
  );
  return {
    id,
    label,
    utilization: Math.min(1, utilization),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function firstDefined(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function humanizeUsageKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function windowLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "Session (5hr)";
  if (minutes === 10_080) return "Weekly (7 day)";
  if (!minutes || !Number.isFinite(minutes)) return fallback;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} day limit`;
  if (minutes % 60 === 0) return `${minutes / 60} hour limit`;
  return `${minutes} minute limit`;
}

/**
 * Normalize only quota windows carried by the native vendor protocol. Context
 * fullness and per-session token spend are deliberately excluded: presenting
 * either as subscription headroom would be a convincing but false number.
 */
export function usageWindowsFromEvent(event: any): CukiiVendorUsageWindow[] {
  const rateLimitInfo =
    event?.rate_limit_info ??
    event?.rateLimitInfo ??
    event?.payload?.rate_limit_info ??
    event?.payload?.rateLimitInfo;
  const unifiedCandidate =
    rateLimitInfo?.unifiedWindows ??
    rateLimitInfo?.unified_windows ??
    (rateLimitInfo &&
    typeof rateLimitInfo === "object" &&
    (rateLimitInfo.five_hour ||
      rateLimitInfo.fiveHour ||
      rateLimitInfo.seven_day ||
      rateLimitInfo.sevenDay)
      ? rateLimitInfo
      : undefined);
  if (unifiedCandidate && typeof unifiedCandidate === "object") {
    const unified = unifiedCandidate as Record<string, unknown>;
    const known = new Set([
      "five_hour",
      "fiveHour",
      "session",
      "seven_day",
      "sevenDay",
      "weekly",
      "seven_day_overage_included",
      "sevenDayOverageIncluded",
      "seven_day_overage",
      "sevenDayOverage",
      "extra",
      "extra_usage",
      "extraUsage",
      "overage",
      "modelLabel",
      "model_label",
      "unifiedWindows",
      "unified_windows",
    ]);
    const extras = Object.entries(unified)
      .filter(([key, value]) => !known.has(key) && value && typeof value === "object")
      .map(([key, value]) =>
        usageWindow(
          key,
          String(
            (value as { label?: unknown; modelLabel?: unknown }).label ??
              (value as { modelLabel?: unknown }).modelLabel ??
              humanizeUsageKey(key),
          ),
          value,
        ),
      );
    return [
      usageWindow(
        "five_hour",
        "Session (5hr)",
        firstDefined(unified, ["five_hour", "fiveHour", "session"]),
      ),
      usageWindow(
        "seven_day",
        "Weekly (7 day)",
        firstDefined(unified, ["seven_day", "sevenDay", "weekly"]),
      ),
      usageWindow(
        "model_scoped",
        String(
          unified.modelLabel ?? unified.model_label ?? "Fable limit",
        ),
        firstDefined(unified, [
          "seven_day_overage_included",
          "sevenDayOverageIncluded",
          "seven_day_overage",
          "sevenDayOverage",
          "extra",
          "extra_usage",
          "extraUsage",
          "overage",
        ]) ?? rateLimitInfo?.overage,
      ),
      ...extras,
    ].filter((item): item is CukiiVendorUsageWindow => Boolean(item));
  }

  const rateLimits =
    event?.rate_limits ??
    event?.payload?.rate_limits ??
    event?.rateLimits ??
    event?.payload?.rateLimits;
  if (!rateLimits || typeof rateLimits !== "object") return [];

  if (rateLimits.five_hour || rateLimits.seven_day || rateLimits.model_scoped) {
    const modelScoped = Array.isArray(rateLimits.model_scoped)
      ? rateLimits.model_scoped[0]
      : rateLimits.model_scoped;
    return [
      usageWindow("five_hour", "Session (5hr)", rateLimits.five_hour),
      usageWindow("seven_day", "Weekly (7 day)", rateLimits.seven_day),
      usageWindow(
        "model_scoped",
        String(modelScoped?.label ?? modelScoped?.model ?? "Model limit"),
        modelScoped,
      ),
    ].filter((item): item is CukiiVendorUsageWindow => Boolean(item));
  }

  return ["secondary", "primary"]
    .map((key) => {
      const value = rateLimits[key];
      const minutes =
        typeof value?.window_minutes === "number"
          ? value.window_minutes
          : undefined;
      return usageWindow(
        `${key}:${minutes ?? "unknown"}`,
        windowLabel(
          minutes,
          key === "primary" ? "Primary limit" : "Secondary limit",
        ),
        value,
      );
    })
    .filter((item): item is CukiiVendorUsageWindow => Boolean(item));
}

function completedBackgroundAgentStatus(
  text: string,
): Extract<BridgeEvent, { kind: "thinking" }> | undefined {
  const match = /^Background agent ["“]([^"”\r\n]+)["”] completed\.$/.exec(
    text.trim(),
  );
  if (!match) return undefined;
  return {
    kind: "thinking",
    text: `[nested worker ${match[1]}]\nstatus: completed`,
    vendorActivity: true,
  };
}

/**
 * The loader must not guess from quiet stdout: a long command can still be
 * doing useful work. We only recognise a shell tool whose *entire* command is
 * a known sleep primitive. Compound commands are deliberately excluded: on a
 * tool-start event there is no proof that their sleep phase is current yet.
 */
function explicitWaitForToolStart(
  event: Extract<BridgeEvent, { kind: "toolStart" }>,
): Extract<BridgeEvent, { kind: "wait" }> | undefined {
  if (/(?:^|[_-])(?:monitor|wait)$/i.test(event.name)) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(event.args);
    } catch {
      decoded = undefined;
    }
    const timeout =
      decoded && typeof decoded === "object"
        ? ((decoded as { timeout?: unknown; timeout_seconds?: unknown })
            .timeout ??
          (decoded as { timeout_seconds?: unknown }).timeout_seconds)
        : undefined;
    const durationSeconds =
      typeof timeout === "number" && Number.isFinite(timeout)
        ? timeout
        : undefined;
    return {
      kind: "wait",
      condition:
        durationSeconds === undefined
          ? "Waiting for a monitored condition"
          : `Waiting for a monitor (${durationSeconds}s)`,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
  }

  if (
    !/(?:^|[_ -])(?:shell|bash|powershell|pwsh|terminal)(?:$|[_ -])/i.test(
      event.name,
    )
  ) {
    return undefined;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(event.args);
  } catch {
    return undefined;
  }
  const command =
    decoded && typeof decoded === "object" && "command" in decoded
      ? (decoded as { command?: unknown }).command
      : undefined;
  if (typeof command !== "string") {
    return undefined;
  }

  const standaloneCommand =
    /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:noprofile|noninteractive|nologo)\s+)*(?:-command|-c)\s+["']?(.+?)["']?$/i.exec(
      command.trim(),
    )?.[1] ?? command.trim();
  const match =
    /^sleep\s+(\d+(?:\.\d+)?)\s*(?:s|sec(?:onds?)?)?$/i.exec(
      standaloneCommand,
    ) ??
    /^start-sleep\s+(?:-seconds|-s)\s+(\d+(?:\.\d+)?)$/i.exec(
      standaloneCommand,
    );
  if (!match) {
    return undefined;
  }

  const durationSeconds = Number(match[1]);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return undefined;
  }
  return {
    kind: "wait",
    condition: `Sleeping for ${match[1]} seconds`,
    durationSeconds,
  };
}

/** claude `stream-json` и grok `streaming-messages-json` — один конверт. */
function parseAnthropicEnvelope(event: any): BridgeEvent[] {
  const out: BridgeEvent[] = [];

  if (event.type === "thinking" && event.subtype === "delta") {
    const text = asText(event.text);
    return text ? [{ kind: "thinking", text }] : [];
  }

  if (event.type === "tool_call") {
    const toolCall = event.tool_call;
    const entry =
      toolCall && typeof toolCall === "object"
        ? Object.entries(toolCall).find(([name]) =>
            name.toLowerCase().endsWith("toolcall"),
          )
        : undefined;
    const id = String(event.call_id ?? event.tool_call?.toolCallId ?? "");
    if (!entry || !id) {
      return out;
    }
    const [name, detail] = entry;
    if (event.subtype === "started") {
      const args =
        detail && typeof detail === "object" && "args" in detail
          ? (detail as { args: unknown }).args
          : detail;
      return [
        { kind: "toolStart", id, name, args: JSON.stringify(args ?? {}) },
      ];
    }
    if (event.subtype === "completed") {
      const result =
        detail && typeof detail === "object" && "result" in detail
          ? (detail as { result: unknown }).result
          : detail;
      const isError =
        !!result && typeof result === "object" && "error" in result;
      return [{ kind: "toolResult", id, output: asText(result), isError }];
    }
    return out;
  }

  if (event.type === "assistant" || event.type === "user") {
    const content = event?.message?.content;
    const blocks = Array.isArray(content)
      ? content
      : typeof content === "string"
        ? [{ type: "text", text: content }]
        : [];
    if (
      event.type === "user" &&
      event.isMeta !== true &&
      blocks.length > 0 &&
      blocks.every((block) => block?.type === "text")
    ) {
      const text = blocks.map((block) => asText(block.text)).join("");
      return text ? [{ kind: "userEcho", text }] : [];
    }
    for (const block of blocks) {
      switch (block?.type) {
        case "thinking": {
          const text = asText(block.thinking);
          // Пустой thinking-блок приходит вместе с одной лишь подписью —
          // показывать нечего, а пустой пузырь в ленте выглядит как сбой.
          if (text.trim()) {
            out.push({ kind: "thinking", text });
          }
          break;
        }
        case "text": {
          const text = asText(block.text);
          if (text) {
            out.push(
              completedBackgroundAgentStatus(text) ?? {
                kind: "text",
                text,
              },
            );
          }
          break;
        }
        case "tool_use":
          out.push({
            kind: "toolStart",
            id: String(block.id ?? ""),
            name: String(block.name ?? "tool"),
            args: JSON.stringify(block.input ?? {}),
          });
          break;
        case "tool_result":
          out.push({
            kind: "toolResult",
            id: String(block.tool_use_id ?? ""),
            output: asText(block.content),
            isError: block.is_error === true,
          });
          break;
        default:
          break;
      }
    }
    return out;
  }

  // `result` is the native turn receipt. It can arrive before the CLI process
  // exits, so it must settle UI activity rather than leaving the loader tied
  // to a delayed child close. The final text was already emitted in assistant
  // envelopes and is intentionally not duplicated.
  if (event.type === "result") {
    if (event.is_error) {
      out.push({
        kind: "terminalError",
        text: asText(
          event.result ?? event.error ?? "worker завершился с ошибкой",
        ),
      });
    }
    out.push({ kind: "complete" });
  }
  return out;
}

/**
 * Claude emits lifecycle envelopes that prove stdout is valid stream-json but
 * intentionally have no chat representation. Treating those lines as
 * "unstructured" makes the adapter dump the complete raw JSON stream when a
 * run stops before its result receipt.
 */
function isRecognizedSilentAnthropicEnvelope(event: any): boolean {
  if (event?.type !== "system") return false;
  return ["init", "thinking_tokens", "hook_started", "hook_response"].includes(
    String(event.subtype ?? ""),
  );
}

/** `codex exec --json`: события thread/turn/item. */
function parseCodexThread(event: any): BridgeEvent[] {
  if (event.type === "turn.completed") {
    return [{ kind: "complete" }];
  }
  const item = event?.item;
  if (
    !item ||
    (event.type !== "item.started" && event.type !== "item.completed")
  ) {
    return [];
  }
  const id = String(item.id ?? "");
  const started = event.type === "item.started";

  switch (item.type) {
    case "agent_message":
      return started ? [] : [{ kind: "text", text: asText(item.text) }];
    case "reasoning":
      return started
        ? []
        : [{ kind: "thinking", text: asText(item.text ?? item.summary) }];
    case "error":
      return started ? [] : [{ kind: "error", text: asText(item.message) }];
    case "command_execution":
      return started
        ? [
            {
              kind: "toolStart",
              id,
              name: "Shell",
              args: JSON.stringify({ command: asText(item.command) }),
            },
          ]
        : [
            {
              kind: "toolResult",
              id,
              output: asText(item.aggregated_output),
              isError: item.exit_code !== 0 && item.exit_code !== null,
            },
          ];
    default:
      // Неизвестный тип item'а не глотаем: молчаливая потеря события выглядит
      // как «агент ничего не делал». Показываем его как инструмент с сырым JSON.
      return started
        ? [
            {
              kind: "toolStart",
              id,
              name: String(item.type ?? "item"),
              args: JSON.stringify(item),
            },
          ]
        : [
            {
              kind: "toolResult",
              id,
              output: JSON.stringify(item, null, 2),
              isError: false,
            },
          ];
  }
}

/**
 * `kimi -p --output-format stream-json`: NDJSON в стиле OpenAI chat.
 * Схема снята живым прогоном (kimi-code 0.38):
 *  - `{role:"meta", type:"system.version"|"session.resume_hint"}` — служебное,
 *    в ленту не идёт (но type c "error" всплываем как ошибку, не глотаем);
 *  - `{role:"assistant", tool_calls:[{id, function:{name, arguments}}]}` —
 *    вызов инструмента (arguments уже строка JSON, как у OpenAI);
 *  - `{role:"tool", tool_call_id, content}` — результат инструмента;
 *  - `{role:"assistant", content}` — текст ответа;
 *  - reasoning (если модель его отдаёт) — в `reasoning_content`/`thinking`.
 * Живой Bash-тул печатает свой вывод и сырыми строками мимо JSON — их отсекает
 * общий фильтр `line[0] !== "{"`, поэтому здесь они не всплывают дважды.
 */
function parseKimiNdjson(event: any): BridgeEvent[] {
  const role = event?.role;

  if (role === "meta") {
    if (event.type === "error" || event.type === "system.error") {
      return [
        {
          kind: "error",
          text: asText(event.content ?? event.message ?? event.error),
        },
      ];
    }
    return [];
  }

  if (role === "assistant") {
    const out: BridgeEvent[] = [];
    const thinking = asText(event.reasoning_content ?? event.thinking ?? "");
    if (thinking.trim()) {
      out.push({ kind: "thinking", text: thinking });
    }
    const toolCalls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
    for (const call of toolCalls) {
      const fn = call?.function ?? {};
      out.push({
        kind: "toolStart",
        id: String(call?.id ?? ""),
        name: String(fn.name ?? "tool"),
        args:
          typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {}),
      });
    }
    const text = asText(event.content);
    if (text) {
      out.push({ kind: "text", text });
    }
    return out;
  }

  if (role === "tool") {
    return [
      {
        kind: "toolResult",
        id: String(event.tool_call_id ?? event.id ?? ""),
        output: asText(event.content),
        isError: event.is_error === true || event.isError === true,
      },
    ];
  }

  if (role === "thinking" || role === "reasoning") {
    const text = asText(event.content ?? event.text);
    return text.trim() ? [{ kind: "thinking", text }] : [];
  }

  return [];
}

/**
 * Инкрементальный NDJSON-разборщик: stdout приходит произвольными кусками, и
 * строка легко рвётся посередине. Держим хвост до перевода строки.
 */
export class BridgeEventParser {
  private buffer = "";
  private structured = false;
  /** Scoped to one native bridge process, never shared between user runs. */
  private readonly seenStopHookFeedback = new Set<string>();
  /** FIFO companion to the set: retries are finite without retaining a run. */
  private readonly stopHookFeedbackOrder: string[] = [];

  constructor(private readonly format: BridgeFormat) {}

  /** Хоть одно вендорное событие разобрано — значит формат живой. */
  get sawStructuredOutput(): boolean {
    return this.structured;
  }

  push(chunk: string): BridgeEvent[] {
    if (this.format === "text") {
      return chunk ? [{ kind: "text", text: chunk }] : [];
    }
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const events = lines.flatMap((line) => this.line(line));

    // A terminal protocol receipt must not depend on the producer writing a
    // trailing newline or closing stdout. Codex can leave its CLI alive after
    // emitting one complete JSON object; consume that object as soon as it is
    // syntactically complete so the adapter can begin its own teardown.
    const tail = this.buffer.trim();
    if (!tail || tail[0] !== "{") return events;
    try {
      JSON.parse(tail);
    } catch {
      return events;
    }
    this.buffer = "";
    return [...events, ...this.line(tail)];
  }

  /** Хвост без завершающего перевода строки в конце процесса. */
  flush(): BridgeEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() ? this.line(rest) : [];
  }

  private line(raw: string): BridgeEvent[] {
    const line = raw.trim();
    if (!line || line[0] !== "{") {
      return [];
    }
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const parsed =
      this.format === "codex-thread"
        ? parseCodexThread(event)
        : this.format === "kimi-ndjson"
          ? parseKimiNdjson(event)
          : parseAnthropicEnvelope(event);
    const usage = usageWindowsFromEvent(event);
    if (usage.length > 0) parsed.unshift({ kind: "usage", windows: usage });
    const events = parsed.flatMap((parsedEvent) => {
      // Deduplicate only Claude's explicitly-labelled synthetic hook feedback.
      // Assistant text is deliberately never compared: two equal model turns
      // can be intentional and must remain in the transcript.
      if (isStopHookFeedback(event, parsedEvent)) {
        if (this.seenStopHookFeedback.has(parsedEvent.text)) {
          return [];
        }
        this.seenStopHookFeedback.add(parsedEvent.text);
        this.stopHookFeedbackOrder.push(parsedEvent.text);
        if (this.stopHookFeedbackOrder.length > MAX_STOP_HOOK_FEEDBACK_CACHE) {
          const oldest = this.stopHookFeedbackOrder.shift();
          if (oldest !== undefined) {
            this.seenStopHookFeedback.delete(oldest);
          }
        }
      }
      const wait =
        parsedEvent.kind === "toolStart"
          ? explicitWaitForToolStart(parsedEvent)
          : undefined;
      return wait ? [parsedEvent, wait] : [parsedEvent];
    });
    // Known lifecycle envelopes are valid structured transport even though
    // they deliberately render nothing. Unknown future schema still leaves the
    // raw fallback alive so a real model answer cannot disappear silently.
    if (
      events.length ||
      (this.format === "anthropic-envelope" &&
        isRecognizedSilentAnthropicEnvelope(event))
    ) {
      this.structured = true;
    }
    return events;
  }
}
