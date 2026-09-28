import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CukiiRunBinding } from "@cukii/vendor-bridge";
import { BridgeReactionBroker, bridgeReactionsRoot } from "./bridgeReactions";

let root = "";
const createdMs = Date.now() - 1_000;
const binding: CukiiRunBinding = {
  version: 2,
  vendorPid: 4242,
  processStartToken: "start-token",
  sessionId: "session-a",
  runId: "run-a",
  nonce: "a".repeat(64),
  createdMs,
  expiresMs: createdMs + 60_000,
};
const bindingReader = vi.fn(() => binding);

function writeReaction(
  id = "reaction-a",
  overrides: Record<string, unknown> = {},
): void {
  const directory = path.join(root, "session-a");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${id}.json`),
    JSON.stringify({
      id,
      sessionId: "session-a",
      runId: "run-a",
      producerNonce: "a".repeat(64),
      createdMs: createdMs + 1,
      status: "pending",
      emoji: "❤️",
      ...overrides,
    }),
  );
}

describe("BridgeReactionBroker", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-reactions-"));
    process.env.CUKII_REACTIONS_DIR = root;
    bindingReader.mockClear();
  });

  afterEach(() => {
    delete process.env.CUKII_REACTIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("emits one run-bound reaction for the exact user bubble", () => {
    writeReaction();
    writeReaction("reaction-b", { createdMs: createdMs + 2, emoji: "😂" });
    const seen: unknown[] = [];
    const broker = new BridgeReactionBroker(
      "session-a",
      "run-a",
      "message-user-a",
      (reaction) => seen.push(reaction),
      bindingReader,
    );
    expect(broker.setTargetMessage("message-user-follow-up")).toBe(true);
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.tick();
    expect(seen).toEqual([
      expect.objectContaining({
        reactionId: "reaction-a",
        messageId: "message-user-follow-up",
        emoji: "❤️",
      }),
    ]);
    expect(broker.setTargetMessage("too-late")).toBe(false);
  });

  it("rejects foreign runs, forged nonces, future records and unknown emoji", () => {
    writeReaction("foreign", { runId: "run-b" });
    writeReaction("forged", { producerNonce: "b".repeat(64) });
    writeReaction("future", { createdMs: Date.now() + 60_000 });
    writeReaction("unknown", { emoji: "💣" });
    const seen: unknown[] = [];
    const broker = new BridgeReactionBroker(
      "session-a",
      "run-a",
      "message-user-a",
      (reaction) => seen.push(reaction),
      bindingReader,
    );
    expect(broker.bindVendorProcess(4242)).toBe(true);
    broker.tick();
    expect(seen).toEqual([]);
  });

  it("rejects a process from another run and does not keep the host alive", () => {
    const broker = new BridgeReactionBroker(
      "session-a",
      "run-a",
      "message-user-a",
      () => {},
      bindingReader,
    );
    expect(broker.bindVendorProcess(4242, { ...binding, runId: "run-b" })).toBe(
      false,
    );
    const unref = vi.fn();
    const spy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);
    broker.start();
    expect(unref).toHaveBeenCalled();
    broker.dispose();
    spy.mockRestore();
    expect(bridgeReactionsRoot()).toBe(root);
  });
});
