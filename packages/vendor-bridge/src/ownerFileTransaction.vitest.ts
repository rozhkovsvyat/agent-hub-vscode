import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  withOwnerFileLock,
  writeOwnerFileAtomic,
} from "./ownerFileTransaction";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-owner-file-"));
  roots.push(root);
  return path.join(root, "config.json");
}

describe("owner file transaction", () => {
  it("publishes complete owner-only files without a shared temp pathname", () => {
    const target = fixture();
    writeOwnerFileAtomic(target, '{"owner":1}');
    writeOwnerFileAtomic(target, '{"owner":2}');
    expect(fs.readFileSync(target, "utf8")).toBe('{"owner":2}');
    expect(fs.readdirSync(path.dirname(target))).toEqual(["config.json"]);
    if (process.platform !== "win32")
      expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("recovers only a stale lock whose owning process is proven dead", () => {
    const target = fixture();
    const lock = `${target}.cukii.lock`;
    fs.writeFileSync(lock, `424242:1:${"a".repeat(32)}`, { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    const result = withOwnerFileLock(
      target,
      () => {
        writeOwnerFileAtomic(target, "complete");
        return "ok";
      },
      { processAlive: () => false },
    );
    expect(result).toBe("ok");
    expect(fs.readFileSync(target, "utf8")).toBe("complete");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("never steals an old lock from a live owner", () => {
    const target = fixture();
    const lock = `${target}.cukii.lock`;
    fs.writeFileSync(lock, `424242:1:${"b".repeat(32)}`, { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, stale, stale);
    let ran = false;
    const started = Date.now();
    expect(() =>
      withOwnerFileLock(
        target,
        () => {
          ran = true;
        },
        { processAlive: () => true, timeoutMs: 50 },
      ),
    ).toThrow(/timed out waiting/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ran).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });

  it("reclaims a lock nobody can prove dead once it is abandoned", () => {
    // 🔴 A pid gets reused. The liveness check then answers "alive" forever, so
    // an orphaned lock made every later transaction on that file wait out the
    // full timeout — on the activation path that is a frozen editor window,
    // repeated on every start, until the owner finds the file by hand.
    const target = fixture();
    const lock = `${target}.cukii.lock`;
    fs.writeFileSync(lock, `${process.pid}:1:${"c".repeat(32)}`, {
      mode: 0o600,
    });
    let ran = false;
    withOwnerFileLock(
      target,
      () => {
        ran = true;
        writeOwnerFileAtomic(target, "complete");
      },
      {
        // Eleven minutes after the lock was taken, with its pid still live.
        now: () => Date.now() + 11 * 60_000,
        processAlive: () => true,
        timeoutMs: 200,
      },
    );
    expect(ran).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("complete");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("names the lock file when it gives up, since that is what the owner has to act on", () => {
    const target = fixture();
    const lock = `${target}.cukii.lock`;
    fs.writeFileSync(lock, `424242:1:${"d".repeat(32)}`, { mode: 0o600 });
    expect(() =>
      withOwnerFileLock(target, () => undefined, {
        processAlive: () => true,
        timeoutMs: 50,
      }),
    ).toThrow(lock);
  });

  it("serializes a competing process so read-modify-write fields are not lost", async () => {
    const target = fixture();
    const ready = `${target}.child-ready`;
    writeOwnerFileAtomic(target, JSON.stringify({ base: true }));

    const childScript = String.raw`
      const fs = require("node:fs");
      const target = process.env.CUKII_TEST_TARGET;
      const ready = process.env.CUKII_TEST_READY;
      const lock = target + ".cukii.lock";
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.writeFileSync(fd, "child-owner");
      fs.fsyncSync(fd);
      const stale = JSON.parse(fs.readFileSync(target, "utf8"));
      fs.writeFileSync(ready, "ready", { flag: "wx" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      const tmp = target + ".child." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ ...stale, child: true }), { flag: "wx", mode: 0o600 });
      fs.renameSync(tmp, target);
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    `;
    const child = spawn(process.execPath, ["-e", childScript], {
      env: {
        ...process.env,
        CUKII_TEST_TARGET: target,
        CUKII_TEST_READY: ready,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(ready)).toBe(true);

    withOwnerFileLock(target, () => {
      const current = JSON.parse(fs.readFileSync(target, "utf8"));
      writeOwnerFileAtomic(
        target,
        JSON.stringify({ ...current, extensionHost: true }),
      );
    });

    const childResult = await new Promise<{
      code: number | null;
      stderr: string;
    }>((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    expect(childResult).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({
      base: true,
      child: true,
      extensionHost: true,
    });
  }, 10_000);
});
