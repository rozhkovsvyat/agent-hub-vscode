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

const CODEX_LINES = [
  '{"type":"thread.started","thread_id":"01a0359c"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"pwsh -Command \\"Get-Content hello.txt\\"","status":"in_progress","exit_code":null}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"pwsh","aggregated_output":"line-one\\r\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"line-one"}}',
  '{"type":"turn.completed","usage":{"input_tokens":34622}}',
];

function collect(
  format: "anthropic-envelope" | "codex-thread",
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

  it("не теряет неизвестный тип item у codex", () => {
    const parser = new BridgeEventParser("codex-thread");
    const events = parser.push(
      '{"type":"item.completed","item":{"id":"item_9","type":"file_change","path":"a.ts"}}\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("toolResult");
  });
});
