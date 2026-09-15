import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readRunBindingForPid,
  registerRunBinding,
  resolveAncestorRunBinding,
} from "./bridgeRunBinding";

describe("bridgeRunBinding", () => {
  let root = "";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-run-binding-"));
    process.env.CUKII_BINDING_DIR = root;
  });

  afterEach(() => {
    delete process.env.CUKII_BINDING_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("registers and resolves one live run with an owner-only nonce", () => {
    const now = Date.now();
    const binding = registerRunBinding(process.pid, "session-a", "run-a", now);
    expect(binding).toMatchObject({
      version: 2,
      vendorPid: process.pid,
      sessionId: "session-a",
      runId: "run-a",
      createdMs: now,
    });
    expect(binding?.nonce).toMatch(/^[a-f0-9]{64}$/);
    expect(readRunBindingForPid(process.pid, now)).toEqual(binding);
    expect(resolveAncestorRunBinding(process.pid, now)).toEqual(binding);
    if (process.platform !== "win32") {
      const mode = fs.statSync(path.join(root, `${process.pid}.json`)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  }, 20_000);

  it("rejects pid-reuse evidence, expiry and invalid identifiers", () => {
    const now = Date.now();
    const binding = registerRunBinding(process.pid, "session-a", "run-a", now)!;
    const file = path.join(root, `${process.pid}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ ...binding, processStartToken: "forged" }),
      "utf8",
    );
    expect(readRunBindingForPid(process.pid, now)).toBeUndefined();

    fs.writeFileSync(
      file,
      JSON.stringify({ ...binding, expiresMs: now - 1 }),
      "utf8",
    );
    expect(readRunBindingForPid(process.pid, now)).toBeUndefined();
    expect(registerRunBinding(process.pid, "../escape", "run-a", now)).toBeUndefined();
  }, 20_000);
});
