import { describe, expect, it, vi } from "vitest";

import { BridgeSteeringController } from "./bridgeSteer";

describe("BridgeSteeringController", () => {
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
