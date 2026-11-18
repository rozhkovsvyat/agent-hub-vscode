import { NEW_SESSION_TITLE } from "core/util/constants";
import { describe, expect, it, vi } from "vitest";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  setTitleManuallySet,
  updateSessionTitle,
} from "../slices/sessionSlice";
import { saveCurrentSession } from "./session";

describe("saveCurrentSession title lifecycle", () => {
  it("does not send reconstructed terminal tool rows across the persistence bridge", async () => {
    const state = getEmptyRootState();
    state.session.id = "large-broker-session";
    state.session.title = "Broker history";
    state.session.titleManuallySet = true;
    state.session.history = [
      {
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
          ],
        },
        contextItems: [],
        toolCallStates: [
          {
            toolCallId: "call-1",
            toolCall: {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{}" },
            },
            status: "done",
            parsedArgs: {},
            output: [{ name: "file", description: "", content: "payload" }],
          },
        ],
      },
      {
        message: {
          id: "tool-1",
          role: "tool",
          content: "payload",
          toolCallId: "call-1",
        },
        contextItems: [],
      },
    ] as any;
    const store = createMockStore(state);
    const requestSpy = vi.spyOn(store.mockIdeMessenger, "request");

    await (store.dispatch as any)(
      saveCurrentSession({ openNewSession: false, generateTitle: false }),
    );

    const save = requestSpy.mock.calls.find(
      ([type]) => type === "history/save",
    );
    expect((save?.[1] as any).history).toHaveLength(1);
    expect(
      (save?.[1] as any).history[0].toolCallStates[0].output[0].content,
    ).toBe("payload");
    expect(state.session.history).toHaveLength(2);
  });

  it("turns the first persisted exchange into one semantic title, never a model name", async () => {
    const state = getEmptyRootState();
    state.session.id = "first-real-send";
    state.session.title = NEW_SESSION_TITLE;
    state.session.history = [
      {
        message: {
          id: "user-1",
          role: "user",
          content: "Fix the Windows session lifecycle",
        },
        contextItems: [],
      },
      {
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "I will inspect the lifecycle.",
        },
        contextItems: [],
      },
    ];
    state.config.config.selectedModelByRole.chat = {
      title: "Opus 5",
    } as NonNullable<typeof state.config.config.selectedModelByRole.chat>;
    const store = createMockStore(state);
    store.mockIdeMessenger.responses["chatDescriber/describe"] =
      "Windows session lifecycle";
    const saveSpy = vi.spyOn(store.mockIdeMessenger, "request");

    await (store.dispatch as any)(
      saveCurrentSession({ openNewSession: false, generateTitle: true }),
    );

    expect((store.getState() as any).session.title).toBe(
      "Windows session lifecycle",
    );
    expect((store.getState() as any).session.title).not.toContain("Opus 5");
    expect(saveSpy).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({
        sessionId: "first-real-send",
        title: "Windows session lifecycle",
        chatModelTitle: "Opus 5",
      }),
    );
  });

  it("names a fresh session from the first prompt before the vendor turn finishes", async () => {
    const state = getEmptyRootState();
    state.session.id = "first-prompt";
    state.session.title = NEW_SESSION_TITLE;
    state.session.history = [
      {
        message: {
          id: "user-1",
          role: "user",
          content: "",
        },
        contextItems: [],
        editorState: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "почини фокус формы репорта" }],
            },
          ],
        },
      },
    ] as any;
    const store = createMockStore(state);
    const saveSpy = vi.spyOn(store.mockIdeMessenger, "request");

    await (store.dispatch as any)(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
        provisionalTitle: true,
      }),
    );

    expect((store.getState() as any).session.title).toBe(
      "почини фокус формы репорта",
    );
    expect(saveSpy).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({
        sessionId: "first-prompt",
        title: "почини фокус формы репорта",
      }),
    );
  });

  it("keeps the first-prompt title in the live header instead of restoring New Session", async () => {
    const state = getEmptyRootState();
    state.session.id = "live-header";
    state.session.title = NEW_SESSION_TITLE;
    state.session.history = [
      {
        message: {
          id: "user-1",
          role: "user",
          content: "Fix the Windows session lifecycle",
        },
        contextItems: [],
      },
    ];
    const store = createMockStore(state);

    await (store.dispatch as any)(
      saveCurrentSession({
        openNewSession: false,
        generateTitle: false,
        provisionalTitle: true,
      }),
    );

    expect((store.getState() as any).session.title).toBe(
      "Fix the Windows session lifecycle",
    );
    expect((store.getState() as any).session.title).not.toBe(NEW_SESSION_TITLE);
  });

  it("never auto-overwrites a title manually restored from disk", async () => {
    const state = getEmptyRootState();
    state.session.id = "manual-title";
    state.session.title = "Release notes review";
    state.session.titleManuallySet = true;
    state.session.history = [
      {
        message: {
          id: "user-1",
          role: "user",
          content: "A later prompt must not rename me",
        },
        contextItems: [],
      },
    ];
    const store = createMockStore(state);
    store.mockIdeMessenger.responses["chatDescriber/describe"] =
      "Incorrect generated title";
    const requestSpy = vi.spyOn(store.mockIdeMessenger, "request");

    await (store.dispatch as any)(
      saveCurrentSession({ openNewSession: false, generateTitle: true }),
    );
    await (store.dispatch as any)(
      saveCurrentSession({ openNewSession: false, generateTitle: true }),
    );

    expect((store.getState() as any).session.title).toBe(
      "Release notes review",
    );
    expect(requestSpy).not.toHaveBeenCalledWith(
      "chatDescriber/describe",
      expect.anything(),
    );
    expect(requestSpy).toHaveBeenLastCalledWith(
      "history/list",
      expect.anything(),
    );
    expect(requestSpy).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({
        title: "Release notes review",
        titleManuallySet: true,
      }),
    );
  });

  it("keeps a concurrent manual rename when an auto describer resolves late", async () => {
    const state = getEmptyRootState();
    state.session.id = "concurrent-rename";
    state.session.title = NEW_SESSION_TITLE;
    state.session.history = [
      {
        message: { id: "user-1", role: "user", content: "Initial request" },
        contextItems: [],
      },
      {
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "Assistant reply",
        },
        contextItems: [],
      },
    ];
    state.config.config.selectedModelByRole.chat = {
      title: "Opus 5",
    } as NonNullable<typeof state.config.config.selectedModelByRole.chat>;
    const store = createMockStore(state);
    let resolveDescribe: ((title: string) => void) | undefined;
    const describeStarted = new Promise<void>((resolve) => {
      store.mockIdeMessenger.responseHandlers["chatDescriber/describe"] =
        async () => {
          resolve();
          return await new Promise<string>((resolveTitle) => {
            resolveDescribe = resolveTitle;
          });
        };
    });
    store.mockIdeMessenger.responseHandlers["history/load"] = async ({
      id,
    }) => ({
      sessionId: id,
      title: "Manual rename wins",
      titleManuallySet: true,
      workspaceDirectory: "D:/Brain/vault",
      history: [],
    });
    const saveSpy = vi.spyOn(store.mockIdeMessenger, "request");

    const saving = (store.dispatch as any)(
      saveCurrentSession({ openNewSession: false, generateTitle: true }),
    );
    await describeStarted;
    (store.dispatch as any)(updateSessionTitle("Manual rename wins"));
    (store.dispatch as any)(setTitleManuallySet(true));
    if (!resolveDescribe) {
      throw new Error("The deferred describer did not start");
    }
    resolveDescribe("Late automatic title");
    await saving;

    expect((store.getState() as any).session.title).toBe("Manual rename wins");
    expect((store.getState() as any).session.titleManuallySet).toBe(true);
    expect(saveSpy).toHaveBeenCalledWith(
      "history/save",
      expect.objectContaining({
        title: "Manual rename wins",
        titleManuallySet: true,
      }),
    );
  });
});
