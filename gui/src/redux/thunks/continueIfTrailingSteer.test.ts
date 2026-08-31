import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  ChatHistoryItemWithMessageId,
  newSession,
  normalizeRestoredHistory,
} from "../slices/sessionSlice";
import { setupStore } from "../store";
import {
  continueIfTrailingSteer,
  hasTrailingSteerMessage,
  nextQueuedSteerMessage,
} from "./continueIfTrailingSteer";

function item(
  role: "user" | "assistant",
  content: string,
  isSteer = false,
): ChatHistoryItemWithMessageId {
  return {
    message: { id: `${role}-${content}`, role, content },
    contextItems: [],
    isSteer: isSteer || undefined,
  };
}

describe("hasTrailingSteerMessage", () => {
  it("drains two messages FIFO once per live session gate", async () => {
    const messenger = new MockIdeMessenger();
    const dispatched: string[] = [];
    messenger.streamRequest = vi.fn(async function* (_messageType, data: any) {
      dispatched.push(data.queuedFollowUpMessageId);
      yield [
        {
          role: "assistant",
          content: "",
          cukiiSteerReadMessageId: data.queuedFollowUpMessageId,
        },
      ];
      yield [{ role: "assistant", content: "done", cukiiTerminal: true }];
    }) as typeof messenger.streamRequest;
    const first = item("user", "first", true);
    first.steerStatus = "deferred";
    const second = item("user", "second", true);
    second.steerStatus = "queued";
    const store = setupStore({ ideMessenger: messenger });
    store.dispatch(
      newSession({
        sessionId: "fifo-drain",
        title: "FIFO drain",
        workspaceDirectory: "D:/Brain/vault",
        history: [first, item("assistant", "old output"), second],
        mode: "broker",
        brokerModel: "qwen-3-8-max",
      }),
    );

    await Promise.all([
      store.dispatch(continueIfTrailingSteer()),
      store.dispatch(continueIfTrailingSteer()),
    ]);

    expect(dispatched).toEqual([first.message.id, second.message.id]);
    expect(
      store
        .getState()
        .session.history.filter((entry) => entry.isSteer)
        .map((entry) => entry.steerStatus),
    ).toEqual(["read", "read"]);
  });

  it("leaves a bridge-error follow-up deferred without spinning", async () => {
    const messenger = new MockIdeMessenger();
    messenger.streamRequest = vi.fn(async function* () {
      throw new Error("bridge disconnected");
    }) as typeof messenger.streamRequest;
    const pending = item("user", "retry after reconnect", true);
    pending.steerStatus = "deferred";
    const store = setupStore({ ideMessenger: messenger });
    store.dispatch(
      newSession({
        sessionId: "bridge-error",
        title: "Bridge error",
        workspaceDirectory: "D:/Brain/vault",
        history: [pending],
        mode: "broker",
        brokerModel: "qwen-3-8-max",
      }),
    );

    await store.dispatch(continueIfTrailingSteer());

    expect(messenger.streamRequest).toHaveBeenCalledTimes(1);
    expect(store.getState().session.history[0].steerStatus).toBe("deferred");
  });

  it("does not launch when the pre-stream durable save is rejected", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["history/save"] = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    messenger.streamRequest = vi.fn(async function* () {
      yield [{ role: "assistant", content: "must not run" }];
    }) as typeof messenger.streamRequest;
    const pending = item("user", "persist me first", true);
    pending.steerStatus = "deferred";
    const store = setupStore({ ideMessenger: messenger });
    store.dispatch(
      newSession({
        sessionId: "save-rejected",
        title: "Save rejected",
        workspaceDirectory: "D:/Brain/vault",
        history: [pending],
        mode: "broker",
        brokerModel: "qwen-3-8-max",
      }),
    );

    const result = await store.dispatch(continueIfTrailingSteer());

    expect(result.meta.requestStatus).toBe("rejected");
    expect(messenger.streamRequest).not.toHaveBeenCalled();
    expect(store.getState().session.history[0].steerStatus).toBe("deferred");
  });

  it("stops FIFO after a terminal bridge error instead of dispatching the next item", async () => {
    const messenger = new MockIdeMessenger();
    const dispatched: string[] = [];
    messenger.streamRequest = vi.fn(async function* (_messageType, data: any) {
      dispatched.push(data.queuedFollowUpMessageId);
      yield [
        {
          role: "assistant",
          content: "vendor authentication failed",
          cukiiTerminalError: true,
        },
      ];
    }) as typeof messenger.streamRequest;
    const first = item("user", "first", true);
    first.steerStatus = "deferred";
    const second = item("user", "second", true);
    second.steerStatus = "deferred";
    const store = setupStore({ ideMessenger: messenger });
    store.dispatch(
      newSession({
        sessionId: "terminal-error",
        title: "Terminal error",
        workspaceDirectory: "D:/Brain/vault",
        history: [first, second],
        mode: "broker",
        brokerModel: "qwen-3-8-max",
      }),
    );

    await store.dispatch(continueIfTrailingSteer());

    expect(dispatched).toEqual([first.message.id]);
    expect(
      store
        .getState()
        .session.history.find((entry) => entry.message.id === first.message.id)
        ?.steerStatus,
    ).toBe("deferred");
    expect(
      store
        .getState()
        .session.history.find((entry) => entry.message.id === second.message.id)
        ?.steerStatus,
    ).toBe("deferred");
  });

  it("never dispatches the next old-session item after a session switch", async () => {
    const messenger = new MockIdeMessenger();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const dispatched: string[] = [];
    messenger.streamRequest = vi.fn(async function* (_messageType, data: any) {
      dispatched.push(data.queuedFollowUpMessageId);
      await blocked;
      yield [{ role: "assistant", content: "done", cukiiTerminal: true }];
    }) as typeof messenger.streamRequest;
    const first = item("user", "first old-session item", true);
    first.steerStatus = "deferred";
    const second = item("user", "second old-session item", true);
    second.steerStatus = "deferred";
    const store = setupStore({ ideMessenger: messenger });
    store.dispatch(
      newSession({
        sessionId: "old-session",
        title: "Old",
        workspaceDirectory: "D:/Brain/vault",
        history: [first, second],
        mode: "broker",
        brokerModel: "qwen-3-8-max",
      }),
    );
    const drain = store.dispatch(continueIfTrailingSteer());
    await vi.waitFor(() => expect(dispatched).toEqual([first.message.id]));

    store.dispatch(
      newSession({
        sessionId: "new-session",
        title: "New",
        workspaceDirectory: "D:/Brain/vault",
        history: [],
        mode: "broker",
        brokerModel: "qwen-3-8-max",
      }),
    );
    release();
    await drain;

    expect(dispatched).toEqual([first.message.id]);
    expect(store.getState().session.id).toBe("new-session");
  });

  it("is false for an ordinary user prompt", () => {
    expect(
      hasTrailingSteerMessage({
        history: [item("user", "hello")],
        isStreaming: false,
        isInEdit: false,
      }),
    ).toBe(false);
  });

  it("is false while streaming or in edit", () => {
    const history = [item("user", "steer now", true)];
    expect(
      hasTrailingSteerMessage({
        history,
        isStreaming: true,
        isInEdit: false,
      }),
    ).toBe(false);
    expect(
      hasTrailingSteerMessage({
        history,
        isStreaming: false,
        isInEdit: true,
      }),
    ).toBe(false);
  });

  it("is false when the last message is the assistant", () => {
    expect(
      hasTrailingSteerMessage({
        history: [item("user", "hello"), item("assistant", "working")],
        isStreaming: false,
        isInEdit: false,
      }),
    ).toBe(false);
  });

  it("is true for a trailing non-empty user message", () => {
    const queued = item("user", "do it like Claude", true);
    queued.steerStatus = "queued";
    expect(
      hasTrailingSteerMessage({
        history: [item("user", "hello"), item("assistant", "working"), queued],
        isStreaming: false,
        isInEdit: false,
      }),
    ).toBe(true);
  });

  it("does not replay a follow-up already delivered to the live session", () => {
    const delivered = item("user", "already delivered", true);
    delivered.steerStatus = "delivered";
    expect(
      hasTrailingSteerMessage({
        history: [delivered],
        isStreaming: false,
        isInEdit: false,
      }),
    ).toBe(false);
  });

  it("does not replay a follow-up already read or failed by the live bridge", () => {
    const read = item("user", "already read", true);
    read.steerStatus = "read";
    const failed = item("user", "not accepted", true);
    failed.steerStatus = "failed";
    for (const followUp of [read, failed]) {
      expect(
        hasTrailingSteerMessage({
          history: [followUp],
          isStreaming: false,
          isInEdit: false,
        }),
      ).toBe(false);
    }
  });

  it("runs an unsupported-vendor follow-up after the current response", () => {
    const deferred = item("user", "send after current", true);
    deferred.steerStatus = "deferred";
    expect(
      hasTrailingSteerMessage({
        history: [deferred],
        isStreaming: false,
        isInEdit: false,
      }),
    ).toBe(true);
  });

  it("finds a deferred follow-up even when later assistant output is last", () => {
    const deferred = item("user", "react to this", true);
    deferred.steerStatus = "deferred";
    const session = {
      history: [
        item("user", "original"),
        deferred,
        item("assistant", "finished original turn"),
      ],
      isStreaming: false,
      isInEdit: false,
    };
    expect(nextQueuedSteerMessage(session)?.message.id).toBe(
      deferred.message.id,
    );
  });

  it("keeps a crash-boundary queued item eligible after serialized restore", () => {
    const queued = item("user", "resume after reconnect", true);
    queued.steerStatus = "queued";
    queued.steerSentAt = 10;
    queued.messageReceipt = { sentAt: 10, status: "queued" };
    const restored = normalizeRestoredHistory(
      JSON.parse(JSON.stringify([queued])),
    );

    expect(
      nextQueuedSteerMessage({
        history: restored,
        isStreaming: false,
        isInEdit: false,
      })?.message.id,
    ).toBe(queued.message.id);
    expect(restored[0].steerStatus).toBe("queued");
  });

  it("selects two queued follow-ups in FIFO order and ignores claimed ones", () => {
    const first = item("user", "first", true);
    first.steerStatus = "deferred";
    const second = item("user", "second", true);
    second.steerStatus = "queued";
    const session = {
      history: [first, item("assistant", "noise"), second],
      isStreaming: false,
      isInEdit: false,
    };
    expect(nextQueuedSteerMessage(session)?.message.id).toBe(first.message.id);
    first.steerStatus = "delivered";
    expect(nextQueuedSteerMessage(session)?.message.id).toBe(second.message.id);
  });

  it("does not drain during cancellation", () => {
    const queued = item("user", "after stop", true);
    queued.steerStatus = "queued";
    expect(
      nextQueuedSteerMessage({
        history: [queued],
        isStreaming: false,
        isInEdit: false,
        isCancelling: true,
      }),
    ).toBeUndefined();
  });

  it("keeps an image-only follow-up pending until the route carries image bytes", () => {
    const deferred = item("user", "image", true);
    deferred.message.content = [
      {
        type: "imageUrl",
        imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
      },
    ];
    deferred.steerStatus = "deferred";
    expect(
      hasTrailingSteerMessage({
        history: [deferred],
        isStreaming: false,
        isInEdit: false,
      }),
    ).toBe(false);
  });
});
