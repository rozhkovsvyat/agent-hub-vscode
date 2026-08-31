import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { newSession, setActive } from "../slices/sessionSlice";
import { cancelStream } from "./cancelStream";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("cancelStream", () => {
  it("paints Interrupted immediately while native cancellation finishes", async () => {
    const state = getEmptyRootState();
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "work" },
        contextItems: [],
      },
      {
        message: { id: "a1", role: "assistant", content: "working" },
        contextItems: [],
      },
    ];
    const messenger = new MockIdeMessenger();
    const receipt = deferred<any>();
    messenger.responseHandlers["cukii/cancelBridgeRun"] = vi.fn(
      async () => receipt.promise,
    );
    const store: any = createMockStore(state, messenger);
    store.dispatch(setActive());

    const first = store.dispatch(cancelStream() as any);
    const duplicate = store.dispatch(cancelStream() as any);
    await vi.waitFor(() =>
      expect(
        messenger.responseHandlers["cukii/cancelBridgeRun"],
      ).toHaveBeenCalledTimes(1),
    );
    expect(store.getState().session.isStreaming).toBe(false);
    expect(store.getState().session.isCancelling).toBe(true);
    expect(store.getState().session.history[1].interrupted).toBe(true);

    receipt.resolve({
      requestId: "cancel-1",
      sessionId: state.session.id,
      status: "cancelled",
      interrupted: "turn",
    });
    await Promise.all([first, duplicate]);
    expect(store.getState().session.isStreaming).toBe(false);
    expect(store.getState().session.isCancelling).toBe(false);
    expect(store.getState().session.history[1].interrupted).toBe(true);
    expect(
      store.getState().session.history.filter((item: any) => item.interrupted),
    ).toHaveLength(1);
  });

  it("provider/lifecycle cancellation emits no Interrupted even if native receipt says turn", async () => {
    const state = getEmptyRootState();
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "work" },
        contextItems: [],
      },
      {
        message: { id: "a1", role: "assistant", content: "failed" },
        contextItems: [],
      },
    ];
    const messenger = new MockIdeMessenger();
    messenger.responses["cukii/cancelBridgeRun"] = {
      requestId: "error-cancel",
      sessionId: state.session.id,
      status: "cancelled",
      interrupted: "turn",
    };
    const store: any = createMockStore(state, messenger);
    store.dispatch(setActive());

    await store.dispatch(cancelStream({ source: "error" }) as any);

    expect(
      store.getState().session.history.filter((item: any) => item.interrupted),
    ).toHaveLength(0);
  });

  it("ignores a late user-cancel receipt after the session was replaced", async () => {
    const state = getEmptyRootState();
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "work" },
        contextItems: [],
      },
      {
        message: { id: "a1", role: "assistant", content: "working" },
        contextItems: [],
      },
    ];
    const messenger = new MockIdeMessenger();
    const receipt = deferred<any>();
    messenger.responseHandlers["cukii/cancelBridgeRun"] = vi.fn(
      async () => receipt.promise,
    );
    const store: any = createMockStore(state, messenger);
    store.dispatch(setActive());
    const cancel = store.dispatch(cancelStream() as any);
    await vi.waitFor(() =>
      expect(store.getState().session.isCancelling).toBe(true),
    );
    store.dispatch(
      newSession({
        sessionId: "replacement",
        title: "Replacement",
        workspaceDirectory: "D:/Brain/vault",
        history: [
          {
            message: { id: "u2", role: "user", content: "new" },
            contextItems: [],
          },
          {
            message: { id: "a2", role: "assistant", content: "new answer" },
            contextItems: [],
          },
        ],
      }),
    );
    receipt.resolve({
      requestId: "late",
      sessionId: state.session.id,
      status: "cancelled",
      interrupted: "turn",
    });
    await cancel;

    expect(store.getState().session.id).toBe("replacement");
    expect(
      store.getState().session.history.filter((item: any) => item.interrupted),
    ).toHaveLength(0);
  });

  it("uses a tool receipt without also painting a general interruption", async () => {
    const state = getEmptyRootState();
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "work" },
        contextItems: [],
      },
      {
        message: { id: "a1", role: "assistant", content: "working" },
        contextItems: [],
        toolCallStates: [
          {
            status: "calling",
            toolCallId: "t1",
            toolCall: {
              id: "t1",
              type: "function",
              function: { name: "Read", arguments: "{}" },
            },
            parsedArgs: {},
          },
        ],
      },
    ];
    const messenger = new MockIdeMessenger();
    messenger.responses["cukii/cancelBridgeRun"] = {
      requestId: "cancel-1",
      sessionId: state.session.id,
      status: "cancelled",
      interrupted: "tool",
    };
    const store: any = createMockStore(state, messenger);
    store.dispatch(setActive());
    await store.dispatch(cancelStream() as any);
    expect(store.getState().session.history[1].interrupted).toBe(false);
    expect(store.getState().session.history[1].toolCallStates?.[0].status).toBe(
      "canceled",
    );
  });
});
