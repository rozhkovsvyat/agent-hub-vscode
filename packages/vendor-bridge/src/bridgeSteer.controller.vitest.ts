import { describe, expect, it, vi } from "vitest";

import {
  BridgeSteeringController,
  shouldHoldBridgeTerminal,
} from "./bridgeSteer";

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
    await Promise.resolve();
    expect(order).toEqual(["tool-finished", "stdin:change direction"]);
    expect(controller.hasUnconsumedLiveSteers()).toBe(true);
    expect(controller.consumeVendorEcho("change direction")).toBe("message-1");
    expect(await receipt).toMatchObject({ status: "delivered" });
    order.push("next-model-step");
    expect(order).toEqual([
      "tool-finished",
      "stdin:change direction",
      "next-model-step",
    ]);
    expect(controller.hasUnconsumedLiveSteers()).toBe(false);
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
    const first = controller.deliver(message);
    const duplicate = controller.deliver(message);
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(1);
    expect(controller.consumeVendorEcho("only once")).toBe("message-1");
    expect(await first).toEqual(await duplicate);
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

    const receipt = controller.deliver({
      messageId: "image-1",
      sessionId: "session-1",
      content,
    });
    await Promise.resolve();
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ content }));
    expect(controller.consumeVendorEcho("inspect this")).toBe("image-1");
    await expect(receipt).resolves.toMatchObject({ status: "delivered" });
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
    const first = controller.deliver({
      messageId: "one",
      sessionId: "session-1",
      content: "one",
    });
    const second = controller.deliver({
      messageId: "two",
      sessionId: "session-1",
      content: "two",
    });
    for (let i = 0; i < 20 && writes.length < 2; i++) {
      await Promise.resolve();
    }
    expect(writes).toEqual(["one", "two"]);
    await Promise.resolve();
    expect(controller.consumeVendorEcho("one")).toBe("one");
    expect(controller.consumeVendorEcho("two")).toBe("two");
    await expect(first).resolves.toMatchObject({ status: "delivered" });
    await expect(second).resolves.toMatchObject({ status: "delivered" });
  });

  it("marks only the first exact vendor echo as read and isolates queued follow-ups", async () => {
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async () => true);
    const first = controller.deliver({
      messageId: "one",
      sessionId: "session-1",
      content: "one",
    });
    const second = controller.deliver({
      messageId: "two",
      sessionId: "session-1",
      content: "two",
    });
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(controller.hasUnconsumedLiveSteers()).toBe(true);

    expect(controller.consumeVendorEcho("not a follow-up")).toBeUndefined();
    expect(controller.consumeVendorEcho("one")).toBe("one");
    expect(controller.consumeVendorEcho("one")).toBeUndefined();
    expect(controller.consumeVendorEcho("two")).toBe("two");
    await expect(first).resolves.toMatchObject({ status: "delivered" });
    await expect(second).resolves.toMatchObject({ status: "delivered" });
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

    await Promise.resolve();
    expect(writes).toEqual(["repeat this"]);
    expect(controller.hasUnconsumedLiveSteers()).toBe(true);
    expect(controller.consumeVendorEcho("repeat this")).toBe("first");
    await expect(first).resolves.toMatchObject({ status: "delivered" });
    await Promise.resolve();
    expect(writes).toEqual(["repeat this", "repeat this"]);
    expect(controller.consumeVendorEcho("repeat this")).toBe("second");
    await expect(second).resolves.toMatchObject({ status: "delivered" });
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

  it("lets echo-less vendors retire the ledger on the accepted stdin write", async () => {
    const writes: string[] = [];
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async (message) => {
      writes.push(String(message.content));
      return true;
    });
    const first = controller.deliver({
      messageId: "first",
      sessionId: "session-1",
      content: "same text",
    });
    await Promise.resolve();
    expect(controller.acknowledgeWritten("unknown")).toBe(false);
    expect(controller.acknowledgeWritten("first")).toBe(true);
    await expect(first).resolves.toMatchObject({ status: "delivered" });
    // The write already consumed the envelope: a later identical stdout line
    // is ordinary transcript text, never a second read receipt.
    expect(controller.consumeVendorEcho("same text")).toBeUndefined();

    const second = controller.deliver({
      messageId: "second",
      sessionId: "session-1",
      content: "same text",
    });
    await Promise.resolve();
    expect(controller.acknowledgeWritten("second")).toBe(true);
    await expect(second).resolves.toMatchObject({ status: "delivered" });
    expect(writes).toEqual(["same text", "same text"]);
  });

  it("acknowledges the active Claude stdin write in the writer callback", async () => {
    const acknowledgements: boolean[] = [];
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async (message) => {
      // This is the real adapter order: Node invokes the successful
      // child.stdin.write callback before BridgeSteeringController.flush()
      // receives the writer result.
      acknowledgements.push(controller.acknowledgeWritten(message.messageId));
      return true;
    });

    const receipt = controller.deliver({
      messageId: "live-follow-up",
      sessionId: "session-1",
      content: "read this while the run is active",
    });
    await expect(receipt).resolves.toMatchObject({ status: "delivered" });

    expect(acknowledgements).toEqual([true]);
    expect(
      controller.consumeVendorEcho("read this while the run is active"),
    ).toBeUndefined();
  });

  it("defers a stdin write the vendor never echoed so the outbox can redeliver (ID-228)", async () => {
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async () => true);
    const receipt = controller.deliver({
      messageId: "late-follow-up",
      sessionId: "session-1",
      content: "second prompt",
    });
    await Promise.resolve();
    expect(controller.hasUnconsumedLiveSteers()).toBe(true);
    expect(shouldHoldBridgeTerminal(controller)).toBe(true);
    controller.close();
    await expect(receipt).resolves.toMatchObject({ status: "deferred" });
    expect(controller.hasUnconsumedLiveSteers()).toBe(false);
    expect(shouldHoldBridgeTerminal(controller)).toBe(false);
  });

  it("does not treat a later follow-up echo as delivery of an earlier unconsumed one (ID-238)", async () => {
    const controller = new BridgeSteeringController("session-1", true);
    controller.attachWriter(async () => true);
    const first = controller.deliver({
      messageId: "first",
      sessionId: "session-1",
      content: "inbox ADR belongs in partner",
    });
    const second = controller.deliver({
      messageId: "second",
      sessionId: "session-1",
      content: "read this one",
    });
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    expect(controller.consumeVendorEcho("read this one")).toBe("second");
    await expect(second).resolves.toMatchObject({ status: "delivered" });
    expect(controller.hasUnconsumedLiveSteers()).toBe(true);
    controller.close();
    await expect(first).resolves.toMatchObject({ status: "deferred" });
  });
});
