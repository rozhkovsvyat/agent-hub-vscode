import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  activeSteerFile,
  appendSteerMessage,
  beginSteerSession,
  endSteerSession,
  steerPromptInstruction,
} from "./bridgeSteer";

function tempSteerPath(): string {
  return path.join(
    os.tmpdir(),
    `cukii-steer-test-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
}

describe("bridgeSteer", () => {
  afterEach(() => {
    endSteerSession();
  });

  it("writes the live path into the prompt instruction", () => {
    const instruction = steerPromptInstruction("C:\\tmp\\steer.txt");
    expect(instruction).toContain("C:\\tmp\\steer.txt");
    expect(instruction).toMatch(/WHILE you work/i);
    expect(instruction).toMatch(/After every tool batch/i);
  });

  it("appends USER blocks only while a session is active", () => {
    const filePath = tempSteerPath();
    expect(appendSteerMessage("too early")).toBe(false);
    beginSteerSession(filePath);
    expect(activeSteerFile()).toBe(filePath);
    expect(appendSteerMessage("  first follow-up  ")).toBe(true);
    expect(appendSteerMessage("second")).toBe(true);
    expect(appendSteerMessage("   ")).toBe(false);
    const body = fs.readFileSync(filePath, "utf8");
    expect(body).toBe("USER:\nfirst follow-up\n\nUSER:\nsecond\n\n");
    endSteerSession();
    expect(activeSteerFile()).toBeUndefined();
    expect(appendSteerMessage("after end")).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
