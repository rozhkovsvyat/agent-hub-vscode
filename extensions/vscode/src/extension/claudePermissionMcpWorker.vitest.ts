import { afterEach, describe, expect, it, vi } from "vitest";

import { ClaudePermissionBroker } from "./claudePermissionBroker";
import {
  JsonlFrameReader,
  mcpResponseForMessage,
  resetPermissionPipeClientForTests,
} from "./claudePermissionMcpWorker";

const brokers: ClaudePermissionBroker[] = [];
afterEach(async () => {
  resetPermissionPipeClientForTests();
  await Promise.all(brokers.splice(0).map((broker) => broker.dispose()));
  delete process.env.CUKII_PERMISSION_PIPE;
  delete process.env.CUKII_PERMISSION_TOKEN;
  delete process.env.CUKII_PERMISSION_SESSION;
});

describe("standalone Claude permission MCP worker", () => {
  it("keeps valid JSON-RPC frames after an oversized or fragmented frame", () => {
    const reader = new JsonlFrameReader(256);
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    const request = JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(reader.push(`${"x".repeat(257)}\n${initialize}\n`)).toEqual([
      { type: "oversize" },
      { type: "line", line: initialize },
    ]);
    expect(reader.push(request.slice(0, 18))).toEqual([]);
    expect(reader.push(`${request.slice(18)}\n${initialize}\n`)).toEqual([
      { type: "line", line: request },
      { type: "line", line: initialize },
    ]);
  });

  it("bounds an unterminated oversized worker frame and resumes at the next newline", () => {
    const reader = new JsonlFrameReader(32);
    const valid = '{"jsonrpc":"2.0"}';
    expect(reader.push("x".repeat(33))).toEqual([{ type: "oversize" }]);
    expect(reader.push(`discarded tail\n${valid}\n`)).toEqual([
      { type: "line", line: valid },
    ]);
  });

  it("implements initialize and tools/list JSON-RPC", async () => {
    const initialize = await mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(initialize).toMatchObject({ jsonrpc: "2.0", id: 1 });
    const list = await mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect((list?.result as { tools: { name: string }[] }).tools).toEqual([
      expect.objectContaining({ name: "request" }),
    ]);
  });

  it("returns exactly one text block with the broker's original input", async () => {
    let request: any;
    const broker = new ClaudePermissionBroker({
      panelId: "panel-a",
      sessionId: "session-a",
      mode: "manual",
      onRequest: (next) => {
        request = next;
      },
    });
    brokers.push(broker);
    await broker.start();
    process.env.CUKII_PERMISSION_PIPE = broker.pipeName;
    process.env.CUKII_PERMISSION_TOKEN = broker.token;
    process.env.CUKII_PERMISSION_SESSION = "session-a";
    const response = mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "request",
        arguments: { tool_name: "Bash", input: { command: "git status" } },
      },
    });
    await vi.waitFor(() => expect(request).toBeDefined());
    broker.respond({ ...request, decision: "allow" });
    const result = await response;
    const content = (
      result?.result as { content: { type: string; text: string }[] }
    ).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
    expect(JSON.parse(content[0].text)).toEqual({
      behavior: "allow",
      updatedInput: { command: "git status" },
    });
  });

  it("denies a worker with invalid auth instead of auto-approving", async () => {
    process.env.CUKII_PERMISSION_PIPE = "\\\\.\\pipe\\missing-cukii-permission";
    process.env.CUKII_PERMISSION_TOKEN = "wrong";
    process.env.CUKII_PERMISSION_SESSION = "wrong";
    const result = await mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "request",
        arguments: { tool_name: "Bash", input: { command: "whoami" } },
      },
    });
    const content = (result?.result as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toEqual({ behavior: "deny" });
  });

  it.each([
    [null, -32600],
    [[], -32600],
    [{ jsonrpc: "1.0", id: 1, method: "initialize" }, -32600],
    [{ jsonrpc: "2.0", id: {}, method: "initialize" }, -32600],
    [{ jsonrpc: "2.0", id: 1, method: "unknown" }, -32601],
  ])("rejects malformed JSON-RPC without throwing", async (message, code) => {
    const response = await mcpResponseForMessage(message);
    expect((response?.error as { code: number }).code).toBe(code);
  });
});
