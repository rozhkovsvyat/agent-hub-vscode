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
  | { kind: "thinking"; text: string }
  | { kind: "toolStart"; id: string; name: string; args: string }
  | { kind: "toolResult"; id: string; output: string; isError: boolean }
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

/**
 * The loader must not guess from quiet stdout: a long command can still be
 * doing useful work. We only recognise a shell tool whose *entire* command is
 * a known sleep primitive. Compound commands are deliberately excluded: on a
 * tool-start event there is no proof that their sleep phase is current yet.
 */
function explicitWaitForToolStart(
  event: Extract<BridgeEvent, { kind: "toolStart" }>,
): Extract<BridgeEvent, { kind: "wait" }> | undefined {
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
            out.push({ kind: "text", text });
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
    return lines.flatMap((line) => this.line(line));
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
    const events = parsed.flatMap((parsedEvent) => {
      const wait =
        parsedEvent.kind === "toolStart"
          ? explicitWaitForToolStart(parsedEvent)
          : undefined;
      return wait ? [parsedEvent, wait] : [parsedEvent];
    });
    // An init/schema-drift JSON object is not useful structured output. Keep
    // raw-stdout fallback alive until an event the UI can actually render.
    if (events.length) {
      this.structured = true;
    }
    return events;
  }
}
