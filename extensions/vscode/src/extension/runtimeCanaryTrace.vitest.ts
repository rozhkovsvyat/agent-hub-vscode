import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeCanaryTrace,
  runtimeCanaryExtensionBinding,
  runtimeCanaryResult,
  runtimeCanaryTurn,
} from "./runtimeCanaryTrace";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime canary trace", () => {
  it("records only an explicit user envelope as ordered causal events", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-canary-"));
    temporaryDirectories.push(directory);
    const tracePath = path.join(directory, "events.jsonl");
    fs.writeFileSync(
      path.join(directory, "package.json"),
      '{"version":"2.0.68"}',
    );
    const turn = runtimeCanaryTurn([
      { role: "user", content: "ordinary prompt must never be traced" },
      {
        role: "user",
        content:
          "[[CUKII_RUNTIME_CANARY turn_id=turn_1234567890 nonce=nonce_1234567890123456]] reply with OK",
      },
    ]);

    expect(turn).toEqual({
      turnId: "turn_1234567890",
      nonce: "nonce_1234567890123456",
    });
    const extension = runtimeCanaryExtensionBinding(directory, "2.0.68");
    expect(extension?.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    const trace = new RuntimeCanaryTrace(
      turn!,
      "kimi-k3",
      extension!,
      tracePath,
    );
    trace.record("ui_submit");
    trace.record("bridge_dispatch");
    trace.record("vendor_completed", { result: "completed", exit_code: 0 });

    const events = fs
      .readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.event)).toEqual([
      "ui_submit",
      "bridge_dispatch",
      "vendor_completed",
    ]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.every((event) => event.turn_id === turn!.turnId)).toBe(true);
    expect(events.every((event) => event.nonce === turn!.nonce)).toBe(true);
    expect(events.every((event) => event.extension_root === directory)).toBe(
      true,
    );
  });

  it("does not mint a trace from a normal or malformed user turn", () => {
    expect(
      runtimeCanaryTurn([{ role: "user", content: "hello" }]),
    ).toBeUndefined();
    expect(
      runtimeCanaryTurn([
        { role: "user", content: "[[CUKII_RUNTIME_CANARY turn_id=x nonce=y]]" },
      ]),
    ).toBeUndefined();
  });

  it("classifies provider quota as blocked evidence, never completion", () => {
    expect(runtimeCanaryResult(1, "", "provider quota exhausted")).toBe(
      "provider_quota",
    );
    expect(runtimeCanaryResult(0, "reply", "")).toBe("completed");
    expect(runtimeCanaryResult(1, "", "fatal")).toBe("failed");
  });
});
