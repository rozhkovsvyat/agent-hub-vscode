import { describe, expect, it } from "vitest";

import { BridgeEvent, BridgeEventParser } from "./bridgeEvents";

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
  it("разбирает конверт claude stream-json", () => {
    const { events, parser } = collect("anthropic-envelope", CLAUDE_LINES);
    expect(parser.sawStructuredOutput).toBe(true);
    expect(events).toEqual([
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

  it("разбирает событийную модель codex exec --json", () => {
    const { events } = collect("codex-thread", CODEX_LINES);
    expect(events).toEqual([
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

  it("не считает обычный assistant text завершением turn", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(
      parser.push(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Working."}]}}\n',
      ),
    ).toEqual([{ kind: "text", text: "Working." }]);
  });

  it("возвращает terminal receipt из Claude result до закрытия процесса", () => {
    const parser = new BridgeEventParser("anthropic-envelope");
    expect(
      parser.push(
        '{"type":"result","subtype":"success","is_error":false,"result":"Done"}\n',
      ),
    ).toEqual([{ kind: "complete" }]);
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
