import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cancelQuestionForRpc,
  dropOutstandingRequests,
  finalizeCancelled,
  mcpResponseForMessage,
  outstandingRequests,
  reactionsRoot,
  rpcQuestionRequests,
  waitForAnswer,
  waitTimeoutMs,
} from "./cukiiQuestionMcp";

let root = "";

function writeRequest(id = "question-a", status = "pending") {
  const directory = path.join(root, "session-a");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      id,
      sessionId: "session-a",
      runId: "run-a",
      producerNonce: "a".repeat(64),
      createdMs: Date.now(),
      status,
      questions: [
        {
          id: "deploy",
          header: "Deploy",
          question: "Where?",
          options: [
            { label: "Stage", description: "Use staging." },
            { label: "Prod", description: "Use production." },
          ],
        },
      ],
      ...(status === "answered" ? { answers: { deploy: "Prod" } } : {}),
    }),
  );
  return file;
}

/** Deterministic clock: every sleep advances time, so the wait loop expires. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("cukiiQuestionMcp", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-question-mcp-"));
    process.env.CUKII_REACTIONS_DIR = path.join(root, "reactions");
  });

  afterEach(() => {
    outstandingRequests.clear();
    delete process.env.CUKII_REACTIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("waits indefinitely by default but bounds an explicit operator timeout", () => {
    expect(waitTimeoutMs({})).toBe(Number.POSITIVE_INFINITY);
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "5000" })).toBe(60_000);
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "99999999999" })).toBe(
      2 * 60 * 60_000,
    );
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "abc" })).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("returns an answered record as soon as the broker writes it", async () => {
    const file = writeRequest("question-a", "answered");
    const record = await waitForAnswer(file, "question-a");
    expect(record).toMatchObject({
      status: "answered",
      answers: { deploy: "Prod" },
    });
  });

  it("returns an honest timeout receipt and finalizes the record on disk", async () => {
    const file = writeRequest();
    const clock = fakeClock();
    const receipt = await waitForAnswer(file, "question-a", {
      timeoutMs: 1_000,
      ...clock,
    });
    expect(receipt).toEqual({ status: "cancelled", reason: "timeout" });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      status: "cancelled",
      reason: "timeout",
    });
  });

  it("refuses to finalize an answered or foreign record", () => {
    const answered = writeRequest("question-a", "answered");
    expect(finalizeCancelled(answered, "question-a", "timeout")).toBe(false);
    expect(JSON.parse(fs.readFileSync(answered, "utf8")).status).toBe(
      "answered",
    );
    const pending = writeRequest("question-b");
    expect(finalizeCancelled(pending, "question-else", "timeout")).toBe(false);
    expect(JSON.parse(fs.readFileSync(pending, "utf8")).status).toBe("pending");
  });

  it("converges every outstanding request when the vendor disconnects", () => {
    const first = writeRequest("question-a");
    const second = writeRequest("question-b");
    outstandingRequests.set("question-a", first);
    outstandingRequests.set("question-b", second);
    dropOutstandingRequests("vendor disconnected");
    expect(outstandingRequests.size).toBe(0);
    for (const file of [first, second]) {
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
        status: "cancelled",
        reason: "vendor disconnected",
      });
    }
  });

  it("serves the MCP handshake, tool listing and honest call receipts", async () => {
    const initialize = await mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    });
    expect(initialize).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "cukii-question" } },
    });
    const list = await mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const tools = (list?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "request_user_input",
      "react_to_user_message",
      "broker_inbox",
      "broker_inbox_ack",
    ]);
    expect(reactionsRoot()).toBe(path.join(root, "reactions"));
    const answered = await mcpResponseForMessage(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "request_user_input", arguments: {} },
      },
      async () => ({ requestId: "question-a", answers: { deploy: "Prod" } }),
    );
    const answeredResult = answered?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(answeredResult.isError).toBe(false);
    expect(JSON.parse(answeredResult.content[0].text)).toEqual({
      requestId: "question-a",
      answers: { deploy: "Prod" },
    });
    const rejected = await mcpResponseForMessage(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "request_user_input", arguments: {} },
      },
      async () => {
        throw new Error("invalid question contract");
      },
    );
    expect((rejected?.result as { isError: boolean }).isError).toBe(true);
    const reacted = await mcpResponseForMessage(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "react_to_user_message", arguments: { emoji: "❤️" } },
      },
      async () => ({ cancelled: true }),
      async (args) => ({ reacted: true, ...(args as object) }),
    );
    const reactionResult = reacted?.result as {
      isError: boolean;
      content: { text: string }[];
    };
    expect(reactionResult.isError).toBe(false);
    expect(JSON.parse(reactionResult.content[0].text)).toEqual({
      reacted: true,
      emoji: "❤️",
    });
    const inbox = await mcpResponseForMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "broker_inbox", arguments: {} },
      },
      async () => ({}),
      async () => ({}),
      async () => ({ messages: [], batchSize: 0 }),
    );
    expect(JSON.parse((inbox?.result as any).content[0].text)).toEqual({
      messages: [],
      batchSize: 0,
    });
    const ack = await mcpResponseForMessage(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "broker_inbox_ack",
          arguments: { messageIds: ["message-a"] },
        },
      },
      async () => ({}),
      async () => ({}),
      async () => ({}),
      async () => ({ acked: ["message-a"], ackedCount: 1 }),
    );
    expect(JSON.parse((ack?.result as any).content[0].text)).toEqual({
      acked: ["message-a"],
      ackedCount: 1,
    });
    const unknown = await mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "resources/list",
    });
    expect(unknown).toMatchObject({ id: 8, error: { code: -32601 } });
    expect(
      await mcpResponseForMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
      }),
    ).toBeUndefined();
  });
});

describe("request_user_input progress heartbeat (card 20933fd6)", () => {
  // Qwen Code aborts an MCP call that stays silent for mcp.toolIdleTimeoutMs
  // (300 000 ms by default) no matter what the per-server timeout says; a
  // progress notification is the only thing that resets that timer.
  const call = (meta?: Record<string, unknown>) => ({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: {
      name: "request_user_input",
      arguments: {},
      ...(meta ? { _meta: meta } : {}),
    },
  });

  it("reports monotonic progress with the client's token while the user thinks, then stops", async () => {
    const frames: Record<string, unknown>[] = [];
    let answer: (value: unknown) => void = () => undefined;
    const pending = mcpResponseForMessage(
      call({ progressToken: "tok-7" }),
      () => new Promise((resolve) => (answer = resolve)),
      undefined,
      undefined,
      undefined,
      { notify: (frame) => frames.push(frame), intervalMs: 15 },
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    answer({ requestId: "question-a", answers: { go: "Да" } });
    const response = await pending;
    const countAtAnswer = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(countAtAnswer).toBeGreaterThanOrEqual(3);
    expect(frames.length).toBe(countAtAnswer);
    expect(frames.every((f) => f.method === "notifications/progress")).toBe(
      true,
    );
    const progress = frames.map(
      (f) => f.params as { progressToken: string; progress: number },
    );
    expect(progress.every((p) => p.progressToken === "tok-7")).toBe(true);
    expect(progress.map((p) => p.progress)).toEqual(
      progress.map((_, index) => index + 1),
    );
    expect((response?.result as { isError: boolean }).isError).toBe(false);
  });

  it("stays silent when the client asked for no progress", async () => {
    const frames: unknown[] = [];
    await mcpResponseForMessage(
      call(),
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ answers: {} }), 60),
        ),
      undefined,
      undefined,
      undefined,
      { notify: (frame) => frames.push(frame), intervalMs: 10 },
    );
    expect(frames).toEqual([]);
  });

  it("stops reporting when the question is rejected", async () => {
    const frames: unknown[] = [];
    await mcpResponseForMessage(
      call({ progressToken: 9 }),
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("x")), 40),
        ),
      undefined,
      undefined,
      undefined,
      { notify: (frame) => frames.push(frame), intervalMs: 10 },
    );
    const settled = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames.length).toBe(settled);
  });
});

describe("client cancellation retires the question sheet", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-question-cancel-"));
    process.env.CUKII_QUESTIONS_DIR = root;
  });
  afterEach(() => {
    outstandingRequests.clear();
    rpcQuestionRequests.clear();
    delete process.env.CUKII_QUESTIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("cancels exactly the abandoned call's question and nothing else", async () => {
    const abandoned = writeRequest("question-a");
    const live = writeRequest("question-b");
    outstandingRequests.set("question-a", abandoned);
    outstandingRequests.set("question-b", live);
    rpcQuestionRequests.set("7", "question-a");
    rpcQuestionRequests.set("8", "question-b");

    await mcpResponseForMessage({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "idle timeout" },
    });

    const read = (file: string) =>
      JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(read(abandoned)).toMatchObject({
      status: "cancelled",
      reason: "client cancelled the call",
    });
    expect(read(live).status).toBe("pending");
    expect(cancelQuestionForRpc(99, "x")).toBe(false);
  });
});
