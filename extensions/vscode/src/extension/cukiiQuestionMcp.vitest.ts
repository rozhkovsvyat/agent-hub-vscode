import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dropOutstandingRequests,
  finalizeCancelled,
  mcpResponseForMessage,
  outstandingRequests,
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
  });

  afterEach(() => {
    outstandingRequests.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("bounds the wait between one minute and two hours, defaulting to 30", () => {
    expect(waitTimeoutMs({})).toBe(30 * 60_000);
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "90000" })).toBe(90_000);
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "5000" })).toBe(60_000);
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "99999999999" })).toBe(
      2 * 60 * 60_000,
    );
    expect(waitTimeoutMs({ CUKII_QUESTION_TIMEOUT_MS: "abc" })).toBe(
      30 * 60_000,
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
    expect(JSON.parse(fs.readFileSync(pending, "utf8")).status).toBe(
      "pending",
    );
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
    expect(
      (list?.result as { tools: { name: string }[] }).tools,
    ).toEqual([expect.objectContaining({ name: "request_user_input" })]);
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
    const unknown = await mcpResponseForMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/list",
    });
    expect(unknown).toMatchObject({ id: 5, error: { code: -32601 } });
    expect(
      await mcpResponseForMessage({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
      }),
    ).toBeUndefined();
  });
});
