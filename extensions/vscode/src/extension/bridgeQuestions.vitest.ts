import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BridgeQuestionBroker, bridgeQuestionsRoot, RENOTIFY_INTERVAL_MS } from "./bridgeQuestions";
import type { CukiiRunBinding } from "./bridgeRunBinding";

let root = "";
const nonce = "a".repeat(64);
const createdMs = Date.now() - 1_000;

const binding: CukiiRunBinding = {
  version: 2,
  vendorPid: 4242,
  processStartToken: "start-token",
  sessionId: "session-a",
  runId: "run-a",
  nonce,
  createdMs,
  expiresMs: createdMs + 60_000,
};

const bindingReader = vi.fn(() => binding);

function writeRequest(
  id = "question-a",
  overrides: Record<string, unknown> = {},
) {
  const directory = path.join(root, "session-a");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      id,
      sessionId: "session-a",
      runId: "run-a",
      producerNonce: nonce,
      createdMs: createdMs + 1,
      status: "pending",
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
      ...overrides,
    }),
  );
  return file;
}

describe("BridgeQuestionBroker", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-questions-"));
    process.env.CUKII_QUESTIONS_DIR = root;
    bindingReader.mockClear();
  });

  afterEach(() => {
    delete process.env.CUKII_QUESTIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("surfaces a pending request once and writes the exact correlated answer", () => {
    const file = writeRequest();
    const seen: any[] = [];
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      (item) => seen.push(item),
      bindingReader,
    );
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.tick();
    broker.tick();
    expect(seen).toHaveLength(1);
    expect(seen[0].requestId).toBe("question-a");
    expect(
      broker.respond({
        runId: "run-a",
        requestId: "question-a",
        sessionId: "session-a",
        requestFingerprint: seen[0].requestFingerprint,
        answers: { deploy: "Prod" },
      }),
    ).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      status: "answered",
      answers: { deploy: "Prod" },
    });
  });

  it("rejects stale panels, forged fingerprints, incomplete answers and replay", () => {
    writeRequest();
    const seen: any[] = [];
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      (item) => seen.push(item),
      bindingReader,
    );
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.tick();
    const base = {
      runId: "run-a",
      requestId: "question-a",
      sessionId: "session-a",
      requestFingerprint: seen[0].requestFingerprint,
    };
    expect(broker.respond({ ...base, runId: "old-run", cancelled: true })).toBe(
      false,
    );
    expect(
      broker.respond({
        ...base,
        requestFingerprint: "0".repeat(64),
        cancelled: true,
      }),
    ).toBe(false);
    expect(broker.respond({ ...base, answers: {} })).toBe(false);
    expect(broker.respond({ ...base, answers: { deploy: "Stage" } })).toBe(
      true,
    );
    expect(broker.respond({ ...base, answers: { deploy: "Prod" } })).toBe(
      false,
    );
  });

  it("cancels outstanding requests on run disposal", () => {
    const file = writeRequest();
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      () => {},
      bindingReader,
    );
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.start(60_000);
    broker.dispose("session replaced");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      status: "cancelled",
      reason: "session replaced",
    });
  });

  it("keeps the root overridable and does not keep the host alive", () => {
    expect(bridgeQuestionsRoot()).toBe(root);
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      () => {},
      bindingReader,
    );
    broker.start();
    expect(unref).toHaveBeenCalled();
    broker.dispose();
    spy.mockRestore();
  });

  it("ignores foreign-session and oversized user-writable records", () => {
    const foreign = writeRequest("foreign");
    const record = JSON.parse(fs.readFileSync(foreign, "utf8"));
    fs.writeFileSync(
      foreign,
      JSON.stringify({ ...record, sessionId: "another-session" }),
      "utf8",
    );
    const oversized = writeRequest("oversized");
    fs.writeFileSync(
      oversized,
      JSON.stringify({
        ...record,
        id: "oversized",
        questions: [{ ...record.questions[0], question: "x".repeat(5000) }],
      }),
      "utf8",
    );
    const seen: unknown[] = [];
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      (item) => seen.push(item),
      bindingReader,
    );
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.tick();
    expect(seen).toEqual([]);
    expect(
      broker.respond({
        runId: "run-a",
        requestId: "foreign",
        sessionId: "session-a",
        requestFingerprint: "0".repeat(64),
        cancelled: true,
      }),
    ).toBe(false);
  });

  it("rejects stale, foreign-run and forged-producer records", () => {
    writeRequest("stale", { createdMs: createdMs - 1 });
    writeRequest("foreign-run", { runId: "run-b" });
    writeRequest("forged-producer", { producerNonce: "b".repeat(64) });
    writeRequest("future", { createdMs: Date.now() + 60_000 });
    const seen: unknown[] = [];
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      (item) => seen.push(item),
      bindingReader,
    );
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.tick();
    expect(seen).toEqual([]);
  });

  it("refuses a vendor process bound to another run", () => {
    const foreignReader = vi.fn(() => ({ ...binding, runId: "run-b" }));
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      () => {},
      foreignReader,
    );
    expect(broker.bindVendorProcess(4242)).toBe(false);
  });

  it("reuses the verified spawn binding without a second OS probe", () => {
    const reader = vi.fn(() => undefined);
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      () => {},
      reader,
    );
    expect(broker.bindVendorProcess(4242, binding)).toBe(true);
    expect(reader).not.toHaveBeenCalled();
    expect(broker.bindVendorProcess(99, binding)).toBe(false);
  });

  it("re-publishes an unanswered request after the renotify interval", () => {
    vi.useFakeTimers();
    try {
      writeRequest();
      const seen: any[] = [];
      const broker = new BridgeQuestionBroker(
        "session-a",
        "run-a",
        (item) => seen.push(item),
        bindingReader,
      );
      expect(broker.bindVendorProcess(4242)).toBe(true);
      broker.tick();
      broker.tick();
      expect(seen).toHaveLength(1);
      vi.setSystemTime(Date.now() + RENOTIFY_INTERVAL_MS);
      broker.tick();
      expect(seen).toHaveLength(2);
      expect(seen[1].requestId).toBe("question-a");
      expect(seen[1].requestFingerprint).toBe(seen[0].requestFingerprint);
      broker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws a request finalized outside the broker exactly once", () => {
    const file = writeRequest();
    const seen: any[] = [];
    const withdrawn: any[] = [];
    const broker = new BridgeQuestionBroker(
      "session-a",
      "run-a",
      (item) => seen.push(item),
      bindingReader,
      (item) => withdrawn.push(item),
    );
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.tick();
    expect(seen).toHaveLength(1);
    // MCP-side timeout receipt: the record converges to cancelled on disk.
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(
      file,
      JSON.stringify({ ...record, status: "cancelled", reason: "timeout" }),
    );
    broker.tick();
    expect(withdrawn).toEqual([
      { runId: "run-a", requestId: "question-a", sessionId: "session-a" },
    ]);
    broker.tick();
    expect(withdrawn).toHaveLength(1);
    broker.dispose();
  });
});
