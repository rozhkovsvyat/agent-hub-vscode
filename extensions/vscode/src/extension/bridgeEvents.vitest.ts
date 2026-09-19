import { describe, expect, it } from "vitest";

import {
  BridgeEvent,
  BridgeEventParser,
  usageWindowsFromEvent,
} from "./bridgeEvents";

/**
 * Фикстуры — строки из РЕАЛЬНЫХ прогонов CLI (claude stream-json,
 * grok streaming-messages-json, codex exec --json), а не выдуманные по
 * документации. Именно на выдуманной схеме парсер и ломается молча.
 */
const CLAUDE_LINES = [
  '{"type":"system","subtype":"init","cwd":"D:\\\\Brain\\\\vault","session_id":"9252c6e5"}',
  '{"type":"system","subtype":"thinking_tokens","estimated_tokens":50}',
  '{"type":"assistant","message":{"model":"claude-sonnet-5","role":"assistant","content":[{"type":"thinking","thinking":"Надо прочитать файл."},{"type":"text","text":"Читаю файл."},{"type":"tool_use","id":"toolu_0142","name":"Read","input":{"file_path":"hello.txt"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"File does not exist.","is_error":true,"tool_use_id":"toolu_0142"}]}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"Файла нет."}',
];

const GROK_LINES = [
  '{"type":"system","subtype":"init","model":"grok-4.6","permissionMode":"bypassPermissions"}',
  '{"type":"assistant","message":{"role":"assistant","model":"grok-4.6","content":[{"type":"tool_use","id":"call-db19","name":"read_file","input":{"path":"hello.txt"}}]}}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call-db19","content":"line-one"}]}}',
];

const CURSOR_LINES = [
  '{"type":"thinking","subtype":"delta","text":"Checking files."}',
  '{"type":"tool_call","subtype":"started","call_id":"tool_cursor_1","tool_call":{"readToolCall":{"args":{"path":"hello.txt"}}}}',
  '{"type":"tool_call","subtype":"completed","call_id":"tool_cursor_1","tool_call":{"readToolCall":{"result":{"content":"line-one"}}}}',
];

const CODEX_LINES = [
  '{"type":"thread.started","thread_id":"01a0359c"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwsh -Command \\"Get-Content hello.txt\\"","status":"in_progress","exit_code":null}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwsh","aggregated_output":"line-one\\r\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"line-one"}}',
  '{"type":"turn.completed","usage":{"input_tokens":34622}}',
];

const KIMI_LINES = [
  '{"role":"meta","type":"system.version","version":"0.38.0"}',
  '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_Qy6A","function":{"name":"Bash","arguments":"{\\"command\\":\\"ls -1\\"}"}}]}',
  '{"role":"tool","tool_call_id":"tool_Qy6A","content":"hello.txt\\n"}',
  '{"role":"assistant","content":"There is one file: hello.txt"}',
  '{"role":"meta","type":"session.resume_hint","session_id":"session_x","command":"kimi -r session_x"}',
];

function collect(
  format: "anthropic-envelope" | "codex-thread" | "kimi-ndjson",
  lines: string[],
) {
  const parser = new BridgeEventParser(format);
  const events: BridgeEvent[] = [];
  for (const line of lines) {
    events.push(...parser.push(line + "\n"));
  }
  events.push(...parser.flush());
  return { events, parser };
}

describe("BridgeEventParser", () => {
  it("normalizes Claude and Codex quota receipts without confusing context usage", () => {
    expect(
      usageWindowsFromEvent({
        rate_limit_info: {
          unifiedWindows: {
            five_hour: { utilization: 0.48, resetsAt: 1_789_494_600 },
            seven_day: { utilization: 0.53, resetsAt: 1_789_753_800 },
            seven_day_overage_included: { utilization: 0.05 },
          },
        },
      }),
    ).toEqual([
      {
        id: "five_hour",
        label: "Session (5hr)",
        utilization: 0.48,
        resetsAt: 1_789_494_600,
      },
      {
        id: "seven_day",
        label: "Weekly (7 day)",
        utilization: 0.53,
        resetsAt: 1_789_753_800,
      },
      { id: "model_scoped", label: "Fable limit", utilization: 0.05 },
    ]);
    expect(
      usageWindowsFromEvent({
        type: "token_count",
        rate_limits: {
          primary: {
            used_percent: 9,
            window_minutes: 10_080,
            resets_at: 1_789_753_800,
          },
          secondary: {
            used_percent: 31,
            window_minutes: 300,
            resets_at: 1_789_494_600,
          },
        },
      }),
    ).toEqual([
      {
        id: "secondary:300",
        label: "Session (5hr)",
        utilization: 0.31,
        resetsAt: 1_789_494_600,
      },
      {
        id: "primary:10080",
        label: "Weekly (7 day)",
        utilization: 0.09,
        resetsAt: 1_789_753_800,
      },
    ]);
    expect(
      usageWindowsFromEvent({ context_window: { used_percentage: 98 } }),
    ).toEqual([]);
    expect(
      usageWindowsFromEvent({
        rateLimitInfo: {
          unifiedWindows: {
            fiveHour: { utilization: 0.1, resetsAt: 1_789_494_600 },
            sevenDay: { usedPercent: 22, resetAt: 1_789_753_800 },
            extraUsage: { utilization: 0.41 },
          },
        },
      }),
    ).toEqual([
      {
        id: "five_hour",
        label: "Session (5hr)",
        utilization: 0.1,
        resetsAt: 1_789_494_600,
      },
      {
        id: "seven_day",
        label: "Weekly (7 day)",
        utilization: 0.22,
        resetsAt: 1_789_753_800,
      },
      { id: "model_scoped", label: "Fable limit", utilization: 0.41 },
    ]);
  });

  it("emits a private usage event without transcript text", () => {
    const { events } = collect("anthropic-envelope", [
      JSON.stringify({
        type: "system",
        subtype: "rate_limit_event",
        rate_limit_info: {
          unifiedWindows: {
            five_hour: { utilization: 0.25, resetsAt: 1_789_494_600 },
          },
        },
      }),
    ]);
    expect(events).toEqual([
      {
        kind: "usage",
        windows: [
          {
            id: "five_hour",
            label: "Session (5hr)",
            utilization: 0.25,
            resetsAt: 1_789_494_600,
          },
        ],
      },
    ]);
  });

  it("разбирает конверт claude stream-json", () => {
    const { events, parser } = collect("anthropic-envelope", CLAUDE_LINES);
    expect(parser.sawStructuredOutput).toBe(true);
    expect(events).toEqual([
      { kind: "vendorSession", id: "9252c6e5" },
      { kind: "thinking", text: "Надо прочитать файл." },
      { kind: "text", text: "Читаю файл." },
      {
        kind: "toolStart",
        id: "toolu_0142",
        name: "Read",
        args: JSON.stringify({ file_path: "hello.txt" }),
      },
      {
        kind: "toolResult",
        id: "toolu_0142",
        output: "File does not exist.",
        isError: true,
      },
      { kind: "complete" },
    ]);
  });

  it("тем же парсером разбирает grok streaming-messages-json", () => {
    const { events } = collect("anthropic-envelope", GROK_LINES);
    expect(events).toEqual([
      {
        kind: "toolStart",
        id: "call-db19",
        name: "read_file",
        args: JSON.stringify({ path: "hello.txt" }),
      },
      {
        kind: "toolResult",
        id: "call-db19",
        output: "line-one",
        isError: false,
      },
    ]);
  });

  it("разбирает живые Cursor stream-json events", () => {
    const { events } = collect("anthropic-envelope", CURSOR_LINES);
    expect(events).toEqual([
      { kind: "thinking", text: "Checking files." },
      {
        kind: "toolStart",
        id: "tool_cursor_1",
        name: "readToolCall",
        args: JSON.stringify({ path: "hello.txt" }),
      },
      {
        kind: "toolResult",
        id: "tool_cursor_1",
        output: JSON.stringify({ content: "line-one" }),
        isError: false,
      },
    ]);
  });

  it("не дублирует финальный текст Cursor/Grok из terminal result", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"assistant","message":{"role":"assistant","model":"grok-4.6","content":[{"type":"text","text":"Готово."}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"Готово."}',
    ]);

    expect(events).toEqual([
      { kind: "text", text: "Готово." },
      { kind: "complete" },
    ]);
  });

  it("folds Cursor stream-partial deltas and the repeated whole assistant message", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"text","subtype":"delta","text":"После трёх отказов"}',
      '{"type":"text","subtype":"delta","text":" замок должен открыться."}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"После трёх отказов замок должен открыться."}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"После трёх отказов замок должен открыться."}',
    ]);

    expect(events.filter((event) => event.kind === "text")).toEqual([
      { kind: "text", text: "После трёх отказов" },
      { kind: "text", text: " замок должен открыться." },
    ]);
  });

  it("folds Grok cumulative snapshots and drops thinking that would split the capsule", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"thinking","subtype":"delta","text":"plan"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"more plan"},{"type":"text","text":"Начинаю"}]}}',
      '{"type":"thinking","subtype":"delta","text":"still planning"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Начинаю adversarial-ревью"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Начинаю adversarial-ревью"}]}}',
    ]);

    expect(events).toEqual([
      { kind: "thinking", text: "plan" },
      { kind: "thinking", text: "more plan" },
      { kind: "text", text: "Начинаю" },
      { kind: "text", text: " adversarial-ревью" },
    ]);
  });

  it("unwraps Grok stream_event deltas without duplicating the final assistant message", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]}}',
    ]);

    expect(events).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: " world" },
    ]);
  });

  it("routes Qwen background-agent completion to the worker timeline", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Background agent \\\"general-purpose: Review PostToolUse dispatch candidate\\\" completed."}]}}',
    ]);

    expect(events).toEqual([
      {
        kind: "thinking",
        text: "[nested worker general-purpose: Review PostToolUse dispatch candidate]\nstatus: completed",
        vendorActivity: true,
      },
    ]);
  });

  it("keeps ordinary assistant prose that merely mentions a background agent", () => {
    const text = 'The Background agent "review" completed after one retry.';
    const { events } = collect("anthropic-envelope", [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    ]);

    expect(events).toEqual([{ kind: "text", text }]);
  });

  it("разбирает событийную модель codex exec --json", () => {
    const { events } = collect("codex-thread", CODEX_LINES);
    expect(events).toEqual([
      { kind: "vendorSession", id: "01a0359c" },
      {
        kind: "toolStart",
        id: "item_1",
        name: "Shell",
        args: JSON.stringify({
          command: 'pwsh -Command "Get-Content hello.txt"',
        }),
      },
      {
        kind: "toolResult",
        id: "item_1",
        output: "line-one\r\n",
        isError: false,
      },
      { kind: "text", text: "line-one" },
      { kind: "complete" },
    ]);
  });

  it("treats Codex compaction as a turn-complete receipt (ID-240)", () => {
    const parser = new BridgeEventParser("codex-thread");
    expect(
      parser.push(
        '{"type":"item.completed","item":{"id":"item_c","type":"compaction","status":"completed"}}\n',
      ),
    ).toEqual([{ kind: "complete" }]);
    expect(parser.push('{"type":"compaction.completed"}\n')).toEqual([
      { kind: "complete" },
    ]);
    expect(
      parser.push(
        '{"type":"item.completed","item":{"id":"item_c2","type":"context_compaction"}}\n',
      ),
    ).toEqual([{ kind: "complete" }]);
  });

  it("emits a complete Codex receipt without waiting for newline or process exit", () => {
    const parser = new BridgeEventParser("codex-thread");

    expect(parser.push('{"type":"turn.completed"}')).toEqual([
      { kind: "complete" },
    ]);
    expect(parser.flush()).toEqual([]);
  });

  it("помечает только доказуемый standalone sleep как ожидание", () => {
    const { events } = collect("codex-thread", [
      '{"type":"item.started","item":{"id":"sleep_1","type":"command_execution","command":"sleep 12","status":"in_progress"}}',
    ]);

    expect(events).toEqual([
      {
        kind: "toolStart",
        id: "sleep_1",
        name: "Shell",
        args: JSON.stringify({ command: "sleep 12" }),
      },
      {
        kind: "wait",
        condition: "Sleeping for 12 seconds",
        durationSeconds: 12,
      },
    ]);
  });

  it("recognizes explicit PowerShell Start-Sleep but not prose or compound commands", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"I will wait for the result."},{"type":"tool_use","id":"one","name":"Bash","input":{"command":"echo wait && sleep 5"}},{"type":"tool_use","id":"two","name":"Bash","input":{"command":"Start-Sleep -Seconds 7"}},{"type":"tool_use","id":"three","name":"Read","input":{"file_path":"wait.md"}}]}}',
    ]);

    expect(events).toEqual([
      { kind: "text", text: "I will wait for the result." },
      {
        kind: "toolStart",
        id: "one",
        name: "Bash",
        args: JSON.stringify({ command: "echo wait && sleep 5" }),
      },
      {
        kind: "toolStart",
        id: "two",
        name: "Bash",
        args: JSON.stringify({ command: "Start-Sleep -Seconds 7" }),
      },
      {
        kind: "wait",
        condition: "Sleeping for 7 seconds",
        durationSeconds: 7,
      },
      {
        kind: "toolStart",
        id: "three",
        name: "Read",
        args: JSON.stringify({ file_path: "wait.md" }),
      },
    ]);
  });

  it("treats a Monitor tool as an explicit wait instead of a hung loader", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"mon_1","name":"Monitor","input":{"timeout":30}}]}}',
    ]);
    expect(events).toEqual([
      {
        kind: "toolStart",
        id: "mon_1",
        name: "Monitor",
        args: JSON.stringify({ timeout: 30 }),
      },
      {
        kind: "wait",
        condition: "Waiting for a monitor (30s)",
        durationSeconds: 30,
      },
    ]);
  });

  it("recognizes a standalone Start-Sleep behind the native pwsh wrapper", () => {
    const { events } = collect("codex-thread", [
      '{"type":"item.started","item":{"id":"sleep_2","type":"command_execution","command":"pwsh -NoProfile -Command \\"Start-Sleep -Seconds 3\\"","status":"in_progress"}}',
    ]);

    expect(events.at(-1)).toEqual({
      kind: "wait",
      condition: "Sleeping for 3 seconds",
      durationSeconds: 3,
    });
  });

  it("разбирает живой kimi stream-json (NDJSON в стиле OpenAI)", () => {
    const { events, parser } = collect("kimi-ndjson", KIMI_LINES);
    expect(parser.sawStructuredOutput).toBe(true);
    // meta-строки (version/resume_hint) в ленту не идут.
    expect(events).toEqual([
      {
        kind: "toolStart",
        id: "tool_Qy6A",
        name: "Bash",
        args: '{"command":"ls -1"}',
      },
      {
        kind: "toolResult",
        id: "tool_Qy6A",
        output: "hello.txt\n",
        isError: false,
      },
      { kind: "text", text: "There is one file: hello.txt" },
    ]);
  });

  it("собирает строку, разорванную между чанками stdout", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    const whole = CLAUDE_LINES[2] + "\n";
    const cut = Math.floor(whole.length / 2);
    expect(parser.push(whole.slice(0, cut))).toEqual([]);
    const events = parser.push(whole.slice(cut));
    expect(events.map((event) => event.kind)).toEqual([
      "thinking",
      "text",
      "toolStart",
    ]);
  });

  it("не считает формат живым, если структурных событий не было", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(parser.push("совершенно обычный текст\n")).toEqual([]);
    expect(parser.sawStructuredOutput).toBe(false);
  });

  it("recognizes Claude lifecycle envelopes without rendering their raw JSON", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    const lines = [
      '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}',
      '{"type":"system","subtype":"hook_response","hook_name":"SessionStart:startup","stdout":"","exit_code":0,"outcome":"success"}',
    ];

    expect(parser.push(`${lines.join("\n")}\n`)).toEqual([]);
    expect(parser.sawStructuredOutput).toBe(true);
  });

  it("captures a Claude init session id without rendering the envelope", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(
      parser.push(
        '{"type":"system","subtype":"init","session_id":"9252c6e5-aaaa-bbbb-cccc-ddddeeeeffff"}\n',
      ),
    ).toEqual([
      { kind: "vendorSession", id: "9252c6e5-aaaa-bbbb-cccc-ddddeeeeffff" },
    ]);
    expect(parser.sawStructuredOutput).toBe(true);
  });

  it("не считает обычный assistant text завершением turn", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(
      parser.push(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working."}]}}\n',
      ),
    ).toEqual([{ kind: "text", text: "Working." }]);
  });

  it("показывает повторное Stop hook feedback только один раз, не трогая model turns", () => {
    const hookFeedback =
      "Stop hook feedback: ГЕЙТ РИСКОВАННЫХ ПРАВОК: сначала прогони приёмку.";
    const { events } = collect("anthropic-envelope", [
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_acceptance","name":"Bash","input":{"command":"npm test"}}]}}',
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_acceptance","content":"passed"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Прогон идёт."}]}}',
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "text", text: hookFeedback }],
        },
      }),
      // This is a new model turn, not a repeated transport frame.
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Прогон идёт."}]}}',
      // Claude may retry a blocked Stop hook without changing its feedback.
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content: [{ type: "text", text: hookFeedback }],
        },
      }),
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Приёмка завершена."}]}}',
    ]);

    expect(events).toEqual([
      {
        kind: "toolStart",
        id: "toolu_acceptance",
        name: "Bash",
        args: JSON.stringify({ command: "npm test" }),
      },
      {
        kind: "toolResult",
        id: "toolu_acceptance",
        output: "passed",
        isError: false,
      },
      { kind: "text", text: "Прогон идёт." },
      { kind: "text", text: hookFeedback },
      { kind: "text", text: "Прогон идёт." },
      { kind: "text", text: "Приёмка завершена." },
    ]);
  });

  it("не схлопывает отличающийся Stop hook feedback", () => {
    const { events } = collect("anthropic-envelope", [
      '{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Stop hook feedback: first missing receipt"}]}}',
      '{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"text","text":"Stop hook feedback: second missing receipt"}]}}',
    ]);

    expect(events).toEqual([
      { kind: "text", text: "Stop hook feedback: first missing receipt" },
      { kind: "text", text: "Stop hook feedback: second missing receipt" },
    ]);
  });

  it("не считает human user text hook feedback без isMeta", () => {
    const feedback = "Stop hook feedback: human wrote this intentionally";
    const { events } = collect("anthropic-envelope", [
      JSON.stringify({
        type: "user",
        isMeta: false,
        message: { role: "user", content: [{ type: "text", text: feedback }] },
      }),
      JSON.stringify({
        type: "user",
        isMeta: false,
        message: { role: "user", content: [{ type: "text", text: feedback }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: feedback }] },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: feedback }] },
      }),
    ]);

    expect(events).toEqual([
      { kind: "userEcho", text: feedback },
      { kind: "userEcho", text: feedback },
      { kind: "userEcho", text: feedback },
      { kind: "userEcho", text: feedback },
    ]);
  });

  it("forgets old synthetic feedback after the bounded retry cache fills", () => {
    const feedback = (index: number) => `Stop hook feedback: retry ${index}`;
    const envelope = (text: string) =>
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: { role: "user", content: [{ type: "text", text }] },
      });
    const { events } = collect("anthropic-envelope", [
      ...Array.from({ length: 65 }, (_, index) => envelope(feedback(index))),
      envelope(feedback(0)),
    ]);

    // The first of 65 unique frames has been evicted from the 64-item cache,
    // so a later retry is rendered instead of retaining an unbounded history.
    expect(events.filter((event) => event.kind === "text")).toHaveLength(66);
    expect(events.at(-1)).toEqual({ kind: "text", text: feedback(0) });
  });

  it("возвращает terminal receipt из Claude result до закрытия процесса", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(
      parser.push(
        '{"type":"result","subtype":"success","is_error":false,"result":"Done"}\n',
      ),
    ).toEqual([{ kind: "complete" }]);
  });

  it("marks an errored Claude result as a definitive terminal receipt", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(
      parser.push(
        '{"type":"result","subtype":"error","is_error":true,"result":"Session limit reached"}\n',
      ),
    ).toEqual([
      { kind: "terminalError", text: "Session limit reached" },
      { kind: "complete" },
    ]);
  });

  it("keeps a Codex item error non-terminal until its turn receipt", () => {
    const { events } = collect("codex-thread", [
      '{"type":"item.completed","item":{"id":"item_error","type":"error","message":"Disk full"}}',
      '{"type":"turn.completed"}',
    ]);

    expect(events).toEqual([
      { kind: "error", text: "Disk full" },
      { kind: "complete" },
    ]);
  });

  it("does not guess a Kimi meta error is a turn receipt", () => {
    const { events } = collect("kimi-ndjson", [
      '{"role":"meta","type":"error","message":"Retrying"}',
    ]);

    expect(events).toEqual([{ kind: "error", text: "Retrying" }]);
  });

  it("не подавляет raw fallback от одного непонятного JSON-события", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(
      parser.push('{"type":"system","subtype":"future-schema"}\n'),
    ).toEqual([]);
    expect(parser.sawStructuredOutput).toBe(false);
  });

  it("не теряет неизвестный тип item у codex", () => {
    const parser = new BridgeEventParser("codex-thread");
    const events = parser.push(
      '{"type":"item.completed","item":{"id":"item_9","type":"file_change","path":"a.ts"}}\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("toolResult");
  });
});
