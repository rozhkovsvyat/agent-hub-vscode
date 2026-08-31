import { describe, expect, it, vi } from "vitest";

import { BridgeSteeringController } from "./bridgeSteer";

describe("BridgeSteeringController", () => {
  it("delivers a follow-up to the same Claude session before the next step", async () => {
    const order: string[] = ["tool-finished"];
    const controller = new BridgeSteeringController("session-1", true);
    const receipt = controller.deliver({
      messageId: "message-1",
      sessionId: "session-1",
      content: "change direction",
    });
    controller.attachWriter(async (message) => {
      order.push(`stdin:${message.content}`);
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
      content: "only once",
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
        content: "follow up",
      }),
    ).resolves.toMatchObject({ status: "deferred" });
  });

  it("delivers an image steering payload whole instead of reducing it to text", async () => {
    const writer = vi.fn(async () => true);
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(writer);
    const content = [
      { type: "text" as const, text: "inspect this" },
      {
        type: "imageUrl" as const,
        imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
      },
    ];

    await expect(
      controller.deliver({
        messageId: "image-1",
        sessionId: "session-1",
        content,
      }),
    ).resolves.toMatchObject({ status: "delivered" });
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ content }));
  });

  it("never writes a follow-up for a different session", async () => {
    const writer = vi.fn(async () => true);
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(writer);
    await expect(
      controller.deliver({
        messageId: "message-1",
        sessionId: "session-2",
        content: "do not cross sessions",
      }),
    ).resolves.toMatchObject({ status: "deferred", sessionId: "session-2" });
    expect(writer).not.toHaveBeenCalled();
  });

  it("serializes concurrent follow-ups in arrival order", async () => {
    const writes: string[] = [];
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async (message) => {
      await Promise.resolve();
      writes.push(String(message.content));
      return true;
    });
    await Promise.all([
      controller.deliver({
        messageId: "one",
        sessionId: "session-1",
        content: "one",
      }),
      controller.deliver({
        messageId: "two",
        sessionId: "session-1",
        content: "two",
      }),
    ]);
    expect(writes).toEqual(["one", "two"]);
  });

  it("marks only the first exact vendor echo as read and isolates queued follow-ups", async () => {
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async () => true);
    await Promise.all([
      controller.deliver({
        messageId: "one",
        sessionId: "session-1",
        content: "one",
      }),
      controller.deliver({
        messageId: "two",
        sessionId: "session-1",
        content: "two",
      }),
    ]);

    expect(controller.consumeVendorEcho("not a follow-up")).toBeUndefined();
    expect(controller.consumeVendorEcho("one")).toBe("one");
    expect(controller.consumeVendorEcho("one")).toBeUndefined();
    expect(controller.consumeVendorEcho("two")).toBe("two");
  });

  it("serializes equal follow-ups until each exact echo retires its ID", async () => {
    const writes: string[] = [];
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async (message) => {
      writes.push(String(message.content));
      return true;
    });

    const first = controller.deliver({
      messageId: "first",
      sessionId: "session-1",
      content: "repeat this",
    });
    const second = controller.deliver({
      messageId: "second",
      sessionId: "session-1",
      content: "repeat this",
    });

    await expect(first).resolves.toMatchObject({ status: "delivered" });
    await Promise.resolve();
    expect(writes).toEqual(["repeat this"]);
    expect(controller.consumeVendorEcho("repeat this")).toBe("first");
    await expect(second).resolves.toMatchObject({ status: "delivered" });
    expect(writes).toEqual(["repeat this", "repeat this"]);
    expect(controller.consumeVendorEcho("repeat this")).toBe("second");
  });

  it("never reports delivered when close wins an in-flight stdin write", async () => {
    let started!: () => void;
    let finish!: (delivered: boolean) => void;
    const writerStarted = new Promise<void>((resolve) => (started = resolve));
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(
      () =>
        new Promise<boolean>((resolve) => {
          started();
          finish = resolve;
        }),
    );
    const receipt = controller.deliver({
      messageId: "message-1",
      sessionId: "session-1",
      content: "cancel this write",
    });
    await writerStarted;
    controller.close();
    await expect(receipt).resolves.toMatchObject({ status: "deferred" });
    finish(true);
  });
});
