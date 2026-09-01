import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { streamThunkWrapper } from "./streamThunkWrapper";

describe("streamThunkWrapper", () => {
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
});
