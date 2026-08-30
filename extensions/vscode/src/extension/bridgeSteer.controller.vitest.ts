import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CUKII_STEER_TEST_SCRATCH_ROOT } from "./bridgeScratch";
import {
  BridgeSteeringController,
  CUKII_STEER_SCRATCH_ROOT,
  createBridgeSteerSpool,
  createBridgeSteerSpoolForTest,
} from "./bridgeSteer";

const testCanaryRoot = path.join(
  path.dirname(CUKII_STEER_TEST_SCRATCH_ROOT),
  "cukii-steer-security-canary",
);

function removeTestPath(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      fs.unlinkSync(target);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

afterEach(() => {
  removeTestPath(CUKII_STEER_TEST_SCRATCH_ROOT);
  removeTestPath(testCanaryRoot);
});

describe("BridgeSteeringController", () => {
  it.each(["success", "error", "interrupt"])(
    "keeps the %s steering spool under Scratch and cleans its exact file",
    async () => {
      const spool = createBridgeSteerSpool();
      expect(spool.path.toLowerCase()).toContain(
        CUKII_STEER_SCRATCH_ROOT.toLowerCase(),
      );
      await expect(spool.append("change direction")).resolves.toBe(true);
      expect(fs.readFileSync(spool.path, "utf8")).toContain("USER:");

      // The same idempotent operation runs from generator finally on normal
      // completion, errors and cancellation.
      spool.cleanup();
      spool.cleanup();
      expect(fs.existsSync(spool.path)).toBe(false);
    },
  );

  it.each([
    "a/../../../Brain/vault/pwn",
    "a\\..\\..\\..\\Brain\\vault\\pwn",
    "D:\\Brain\\vault\\pwn",
    "\\\\server\\share\\pwn",
    "safe..nonce",
  ])("rejects unsafe nonce %j without touching the outside canary", (nonce) => {
    fs.mkdirSync(testCanaryRoot, { recursive: true });
    const canary = path.join(testCanaryRoot, "unchanged.txt");
    fs.writeFileSync(canary, "do-not-touch", "utf8");

    expect(() => createBridgeSteerSpoolForTest(nonce)).toThrow(
      "opaque safe token",
    );
    expect(fs.readFileSync(canary, "utf8")).toBe("do-not-touch");
    expect(fs.existsSync(path.join(testCanaryRoot, "pwn"))).toBe(false);
  });

  it("fails closed when the fixed test root is a junction", () => {
    fs.mkdirSync(testCanaryRoot, { recursive: true });
    const canary = path.join(testCanaryRoot, "unchanged.txt");
    fs.writeFileSync(canary, "do-not-touch", "utf8");
    fs.symlinkSync(testCanaryRoot, CUKII_STEER_TEST_SCRATCH_ROOT, "junction");

    expect(() => createBridgeSteerSpoolForTest("safe_nonce_012345")).toThrow(
      "Unsafe bridge Scratch path component",
    );
    expect(fs.readFileSync(canary, "utf8")).toBe("do-not-touch");
    expect(
      fs
        .readdirSync(testCanaryRoot)
        .filter((entry) => entry !== "unchanged.txt"),
    ).toEqual([]);
  });

  it("does not clean up a replacement file that it does not own", () => {
    const spool = createBridgeSteerSpoolForTest("safe_nonce_012345");
    fs.unlinkSync(spool.path);
    fs.writeFileSync(spool.path, "replacement-canary", "utf8");

    spool.cleanup();

    expect(fs.readFileSync(spool.path, "utf8")).toBe("replacement-canary");
  });

  it("delivers a follow-up to the same Claude session before the next step", async () => {
    const order: string[] = ["tool-finished"];
    const controller = new BridgeSteeringController("session-1", true);
    const receipt = controller.deliver({
      messageId: "message-1",
      sessionId: "session-1",
      text: "change direction",
    });
    controller.attachWriter(async (text) => {
      order.push(`stdin:${text}`);
      return true;
    });
    expect(await receipt).toMatchObject({ status: "delivered" });
    order.push("next-model-step");
    expect(order).toEqual([
      "tool-finished",
      "stdin:change direction",
      "next-model-step",
    ]);
  });

  it("deduplicates transport retries by message id", async () => {
    const writer = vi.fn(async () => true);
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(writer);
    const message = {
      messageId: "message-1",
      sessionId: "session-1",
      text: "only once",
    };
    const [first, duplicate] = await Promise.all([
      controller.deliver(message),
      controller.deliver(message),
    ]);
    expect(first).toEqual(duplicate);
    expect(writer).toHaveBeenCalledTimes(1);
  });

  it("honestly defers vendors without proven live steering", async () => {
    const controller = new BridgeSteeringController("session-1", false);
    await expect(
      controller.deliver({
        messageId: "message-1",
        sessionId: "session-1",
        text: "follow up",
      }),
    ).resolves.toMatchObject({ status: "deferred" });
  });

  it("never writes a follow-up for a different session", async () => {
    const writer = vi.fn(async () => true);
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(writer);
    await expect(
      controller.deliver({
        messageId: "message-1",
        sessionId: "session-2",
        text: "do not cross sessions",
      }),
    ).resolves.toMatchObject({ status: "deferred", sessionId: "session-2" });
    expect(writer).not.toHaveBeenCalled();
  });

  it("serializes concurrent follow-ups in arrival order", async () => {
    const writes: string[] = [];
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async (text) => {
      await Promise.resolve();
      writes.push(text);
      return true;
    });
    await Promise.all([
      controller.deliver({
        messageId: "one",
        sessionId: "session-1",
        text: "one",
      }),
      controller.deliver({
        messageId: "two",
        sessionId: "session-1",
        text: "two",
      }),
    ]);
    expect(writes).toEqual(["one", "two"]);
  });
});
