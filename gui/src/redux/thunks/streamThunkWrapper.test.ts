import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { cancelStream } from "./cancelStream";
import { streamThunkWrapper } from "./streamThunkWrapper";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("streamThunkWrapper", () => {
  it("ignores a late error after ownership moved to a newer submission", async () => {
    const state = getEmptyRootState();
    state.session.isInEdit = true;
    state.session.isStreaming = true;
    const messenger = new MockIdeMessenger();
    const cancelRequest = vi.spyOn(messenger, "request");
    const store: any = createMockStore(state, messenger);
    let rejectOld!: (error: Error) => void;
    let current = true;
    const runStream = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    const pending = store.dispatch(
      streamThunkWrapper({
        runStream,
        isCurrent: () => current,
        isCancelled: () => false,
        adoptCancellationBoundary: () => undefined,
      }) as any,
    );
    await vi.waitFor(() => expect(runStream).toHaveBeenCalled());

    current = false;
    rejectOld(new Error("late A failure"));
    await pending;

    expect(cancelRequest).not.toHaveBeenCalledWith(
      "cukii/cancelBridgeRun",
      expect.anything(),
    );
    expect(store.getState().session.isStreaming).toBe(true);
  });

  it("persists the user turn before the vendor round-trip", async () => {
    const state = getEmptyRootState();
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "work" },
        contextItems: [],
      },
    ];
    const messenger = new MockIdeMessenger();
    const saveSpy = vi.fn(async (session: any) => ({
      ...session,
      revision: 1,
    }));
    messenger.responseHandlers["history/save"] = saveSpy;
    let savesSeenByRun = -1;
    const runStream = vi.fn(async () => {
      savesSeenByRun = saveSpy.mock.calls.length;
    });
    const store: any = createMockStore(state, messenger);

    await store.dispatch(streamThunkWrapper(runStream) as any);

    expect(runStream).toHaveBeenCalledTimes(1);
    expect(savesSeenByRun).toBe(1);
    expect(saveSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the pre-run save out of edit mode", async () => {
    const state = getEmptyRootState();
    state.session.isInEdit = true;
    state.session.history = [
      {
        message: { id: "u1", role: "user", content: "edit work" },
        contextItems: [],
      },
    ];
    const messenger = new MockIdeMessenger();
    const saveSpy = vi.fn(async (session: any) => ({
      ...session,
      revision: 1,
    }));
    messenger.responseHandlers["history/save"] = saveSpy;
    const runStream = vi.fn(async () => undefined);
    const store: any = createMockStore(state, messenger);

    await store.dispatch(streamThunkWrapper(runStream) as any);

    expect(runStream).toHaveBeenCalledTimes(1);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("does not retry after user Stop overtakes a pending overload recovery cancel", async () => {
    const state = getEmptyRootState();
    state.session.isInEdit = true;
    state.session.isStreaming = true;
    const messenger = new MockIdeMessenger();
    const recoveryReceipt = deferred<any>();
    messenger.responseHandlers["cukii/cancelBridgeRun"] = vi.fn(
      async () => recoveryReceipt.promise,
    );
    const store: any = createMockStore(state, messenger);
    let ownedAborter = store.getState().session.streamAborter;
    const runStream = vi.fn(async () => {
      throw new Error("Model is overloaded");
    });

    const pending = store.dispatch(
      streamThunkWrapper({
        runStream,
        isCurrent: () => true,
        isCancelled: () =>
          store.getState().session.streamAborter !== ownedAborter ||
          ownedAborter.signal.aborted,
        adoptCancellationBoundary: () => {
          ownedAborter = store.getState().session.streamAborter;
        },
      }) as any,
    );
    await vi.waitFor(() =>
      expect(store.getState().session.isCancelling).toBe(true),
    );

    await store.dispatch(cancelStream() as any);
    recoveryReceipt.resolve({
      requestId: "recovery",
      sessionId: state.session.id,
      status: "cancelled",
      interrupted: "turn",
    });
    await pending;

    expect(runStream).toHaveBeenCalledTimes(1);
    expect(store.getState().session.isStreaming).toBe(false);
  });

  it("still retries overload when no user Stop crosses the recovery boundary", async () => {
    vi.useFakeTimers();
    try {
      const state = getEmptyRootState();
      state.session.isInEdit = true;
      state.session.isStreaming = true;
      const messenger = new MockIdeMessenger();
      messenger.responses["cukii/cancelBridgeRun"] = {
        requestId: "recovery",
        sessionId: state.session.id,
        status: "cancelled",
        interrupted: "turn",
      };
      const store: any = createMockStore(state, messenger);
      let ownedAborter = store.getState().session.streamAborter;
      const runStream = vi
        .fn()
        .mockRejectedValueOnce(new Error("Model is overloaded"))
        .mockResolvedValueOnce(undefined);

      const pending = store.dispatch(
        streamThunkWrapper({
          runStream,
          isCurrent: () => true,
          isCancelled: () =>
            store.getState().session.streamAborter !== ownedAborter ||
            ownedAborter.signal.aborted,
          adoptCancellationBoundary: () => {
            ownedAborter = store.getState().session.streamAborter;
          },
        }) as any,
      );
      await vi.runAllTimersAsync();
      await pending;

      expect(runStream).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
