import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import {
  setActive,
  setBrokerModel,
  setInactive,
  setIsInEdit,
} from "../slices/sessionSlice";
import { RootState } from "../store";
import { continueIfTrailingSteer } from "./continueIfTrailingSteer";
import { streamEditThunk } from "./edit";
import { steerDuringStream } from "./steerDuringStream";

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "do it this way instead",
      legacyCommandWithInput: undefined,
    })),
  }),
);

const editorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "do it this way instead" }],
    },
  ],
};

const modifiers: InputModifiers = { useCodebase: false, noContext: true };

function sessionOf(store: ReturnType<typeof createMockStore>) {
  return (store.getState() as RootState).session;
}

function createStoreWithChatModel(
  title = "Claude before handoff",
  brokerModel: RootState["session"]["brokerModel"] = "qwen-3-8-max",
  mockIdeMessenger?: MockIdeMessenger,
) {
  const state = getEmptyRootState();
  state.config.config.selectedModelByRole.chat = {
    title,
    model: "claude-test",
    provider: "anthropic",
  } as NonNullable<
    typeof state.config.config.selectedModelByRole.chat
  >;
  state.session.brokerModel = brokerModel;
  return createMockStore(state, mockIdeMessenger);
}

describe("steerDuringStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes stale streaming input after handoff through the switched model", async () => {
    const store = createStoreWithChatModel(
      "Claude after model switch",
      "codex-5-6-terra",
    );
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    const vendor = vi.spyOn(store.mockIdeMessenger, "streamRequest");
    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);
    const userTurns = sessionOf(store).history.filter(
      (item) => item.message.role === "user" && !item.isSteer,
    );
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.message.content).toBe("do it this way instead");
    expect(
      request.mock.calls.some(([type]) => type === "cukii/steerDuringStream"),
    ).toBe(false);
    expect(vendor).toHaveBeenCalledTimes(1);
    expect(vendor.mock.calls[0]?.[0]).toBe("cukii/streamBridgeChat");
    expect(vendor.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ brokerModel: "codex-5-6-terra" }),
    );
  });

  it("falls back to a normal turn when the run ends during context resolution", async () => {
    let releaseContext!: (value: Awaited<ReturnType<typeof resolveEditorContent>>) => void;
    vi.mocked(resolveEditorContent).mockImplementationOnce(
      () => new Promise((resolve) => (releaseContext = resolve)),
    );
    const store = createStoreWithChatModel();
    store.dispatch(setActive());

    const pending = store.dispatch(
      steerDuringStream({ editorState, modifiers }) as any,
    );
    store.dispatch(setInactive());
    releaseContext({
      selectedContextItems: [],
      selectedCode: [],
      content: "do it this way instead",
      legacyCommandWithInput: undefined,
    });
    await pending;

    const userTurns = sessionOf(store).history.filter(
      (item) => item.message.role === "user" && !item.isSteer,
    );
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.message.content).toBe("do it this way instead");
  });

  it("does not start ten parallel normal turns from ten stale-ref submits", async () => {
    const store = createStoreWithChatModel();
    const pending = Array.from({ length: 10 }, () =>
      store.dispatch(steerDuringStream({ editorState, modifiers }) as any),
    );

    // The first normal fallback claims isStreaming synchronously. Remaining
    // inputs are steering/outbox items, never parallel normal vendor turns.
    const normalTurns = sessionOf(store).history.filter(
      (item) => item.message.role === "user" && !item.isSteer,
    );
    expect(normalTurns).toHaveLength(1);
    await Promise.all(pending);
  });

  it("appends a user message and notifies the native bridge", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());
    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);
    const history = sessionOf(store).history;
    expect(history.at(-1)?.message.role).toBe("user");
    expect(history.at(-1)?.message.content).toBe("do it this way instead");
    expect(history.at(-1)?.steerStatus).toBe("delivered");
    expect(request).toHaveBeenCalledWith(
      "cukii/steerDuringStream",
      expect.objectContaining({
        messageId: expect.any(String),
        sessionId: sessionOf(store).id,
        content: "do it this way instead",
        brokerModel: sessionOf(store).brokerModel,
      }),
    );
    const saves = request.mock.calls.filter(
      ([type]) => type === "history/save",
    );
    expect(saves).toHaveLength(2);
    expect((saves[0]?.[1] as any).history.at(-1)).toMatchObject({
      isSteer: true,
      steerStatus: "queued",
    });
  });

  it("rejects before live delivery when the durable outbox save fails", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["history/save"] = vi.fn(async () => {
      throw new Error("history unavailable");
    });
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());

    const result = await store.dispatch(
      steerDuringStream({ editorState, modifiers }) as any,
    );

    expect(result.meta.requestStatus).toBe("rejected");
    expect(
      request.mock.calls.some(([type]) => type === "cukii/steerDuringStream"),
    ).toBe(false);
    expect(sessionOf(store).history.at(-1)?.steerStatus).toBe("queued");
  });

  it("keeps image attachments in an active-run steering payload", async () => {
    vi.mocked(resolveEditorContent).mockResolvedValueOnce({
      selectedContextItems: [],
      selectedCode: [],
      content: [
        { type: "text", text: "inspect this" },
        {
          type: "imageUrl",
          imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
        },
      ],
      legacyCommandWithInput: undefined,
    });
    const mockIdeMessenger = new MockIdeMessenger();
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());

    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);

    expect(request).toHaveBeenCalledWith(
      "cukii/steerDuringStream",
      expect.objectContaining({
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "imageUrl",
            imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
          },
        ],
      }),
    );
    expect(sessionOf(store).history.at(-1)?.message.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "imageUrl" })]),
    );
  });

  it("keeps the run alive and queues the follow-up when the vendor cannot steer live", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/steerDuringStream"] = vi.fn(
      async () => ({
        messageId: "mock-steer",
        sessionId: "mock-session",
        status: "deferred" as const,
      }),
    );
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());

    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);

    // Non-live vendors are fed through the durable outbox at the turn
    // boundary. The running turn must never be interrupted for this, so no
    // cancellation request may go out; only an explicit user Stop kills runs.
    expect(
      request.mock.calls.some(([type]) => type === "cukii/cancelBridgeRun"),
    ).toBe(false);
    const steer = sessionOf(store).history.find((item) => item.isSteer);
    expect(steer?.steerStatus).toBe("queued");
    expect(steer?.messageReceipt?.status).toBe("queued");
  });

  it("keeps a follow-up whose transport died and drains it once the turn settles", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/steerDuringStream"] = vi.fn(
      async () => {
        throw new Error("active bridge run disappeared");
      },
    );
    const redelivered: string[] = [];
    mockIdeMessenger.streamRequest = vi.fn(async function* (
      _messageType,
      data: any,
    ) {
      redelivered.push(data.queuedFollowUpMessageId);
      yield [
        {
          role: "thinking",
          content: "Vendor accepted the follow-up",
          cukiiVendorActivity: true,
        },
      ];
      yield [{ role: "assistant", content: "done", cukiiTerminal: true }];
    }) as typeof mockIdeMessenger.streamRequest;
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());

    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);

    // Transport loss must not interrupt the (possibly still healthy) run,
    // and the bubble must stay drainable instead of parking on "failed".
    expect(
      request.mock.calls.some(([type]) => type === "cukii/cancelBridgeRun"),
    ).toBe(false);
    const steer = sessionOf(store).history.find((item) => item.isSteer);
    expect(steer?.steerStatus).toBe("queued");
    // The turn is still marked streaming, so nothing may redeliver yet.
    expect(redelivered).toHaveLength(0);

    // The run settles; the outbox drain delivers the bubble as a fresh turn.
    store.dispatch(setInactive());
    await store.dispatch(continueIfTrailingSteer() as any);

    expect(redelivered).toEqual([steer?.message.id]);
    const delivered = sessionOf(store).history.find(
      (item) => item.message.id === steer?.message.id,
    );
    expect(delivered?.steerStatus).toBe("read");
    expect(delivered?.messageReceipt?.status).toBe("read");
  });

  it("does not interrupt when the vendor accepts the steer live", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    // Default mock returns status "delivered" (Claude-style live injection).
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());

    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);

    expect(
      request.mock.calls.some(([type]) => type === "cukii/cancelBridgeRun"),
    ).toBe(false);
    expect(sessionOf(store).history.at(-1)?.steerStatus).toBe("delivered");
  });
});

describe("steerDuringStream during an edit run", () => {
  it("preserves a steer sent while the edit run streams and drains it once the edit settles", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const request = vi.spyOn(mockIdeMessenger, "request");
    const redelivered: string[] = [];
    mockIdeMessenger.streamRequest = vi.fn(async function* (
      _messageType,
      data: any,
    ) {
      redelivered.push(data.queuedFollowUpMessageId);
      yield [
        {
          role: "thinking",
          content: "Vendor accepted the follow-up",
          cukiiVendorActivity: true,
        },
      ];
      yield [{ role: "assistant", content: "done", cukiiTerminal: true }];
    }) as typeof mockIdeMessenger.streamRequest;
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());
    store.dispatch(setIsInEdit(true));

    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);

    // The composer is already cleared by the time the thunk runs; the edit
    // window has no live steer channel, so the text must land in the durable
    // outbox instead of vanishing.
    const steer = sessionOf(store).history.find((item) => item.isSteer);
    expect(steer).toBeDefined();
    expect(steer?.message.content).toBe("do it this way instead");
    expect(steer?.steerStatus).toBe("deferred");
    expect(
      request.mock.calls.some(([type]) => type === "cukii/steerDuringStream"),
    ).toBe(false);
    expect(
      request.mock.calls.filter(([type]) => type === "history/save"),
    ).toHaveLength(1);

    // The edit run settles and edit mode ends; the drain delivers the capsule
    // as a fresh vendor turn.
    store.dispatch(setInactive());
    store.dispatch(setIsInEdit(false));
    await store.dispatch(continueIfTrailingSteer() as any);

    expect(redelivered).toEqual([steer?.message.id]);
    const delivered = sessionOf(store).history.find(
      (item) => item.message.id === steer?.message.id,
    );
    expect(delivered?.steerStatus).toBe("read");
  });

  it("gives the durable outbox its drain chance when an edit run finishes", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["edit/sendPrompt"] = vi.fn(
      async () => "edited content",
    );
    const state = getEmptyRootState();
    state.editModeState.codeToEdit = [
      {
        filepath: "file.py",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 1, character: 0 },
        },
        contents: "old code",
      },
    ] as RootState["editModeState"]["codeToEdit"];
    const store = createMockStore(state, mockIdeMessenger);
    store.dispatch(setIsInEdit(true));
    store.dispatch(setActive());

    await store.dispatch(
      streamEditThunk({
        editorState,
        codeToEdit: state.editModeState.codeToEdit,
      }) as any,
    );

    expect(sessionOf(store).isStreaming).toBe(false);
    expect(
      store
        .getActions()
        .some(
          (action: any) =>
            action.type === "chat/continueIfTrailingSteer/pending",
        ),
    ).toBe(true);
  });

  it("carries a model-switched steer through the outbox to the new vendor", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    // The extension refuses live injection once the run's brokerModel no
    // longer matches the selected one; the GUI only sees the deferred receipt.
    mockIdeMessenger.responseHandlers["cukii/steerDuringStream"] = vi.fn(
      async () => ({
        messageId: "mock-steer",
        sessionId: "mock-session",
        status: "deferred" as const,
      }),
    );
    const streams: any[] = [];
    mockIdeMessenger.streamRequest = vi.fn(async function* (
      _messageType,
      data: any,
    ) {
      streams.push(data);
      yield [
        {
          role: "thinking",
          content: "Vendor accepted the follow-up",
          cukiiVendorActivity: true,
        },
      ];
      yield [{ role: "assistant", content: "done", cukiiTerminal: true }];
    }) as typeof mockIdeMessenger.streamRequest;
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());
    // The user already switched vendors while the old model's run streams.
    store.dispatch(setBrokerModel("codex-5-6-sol"));

    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);

    expect(
      request.mock.calls.some(([type]) => type === "cukii/steerDuringStream"),
    ).toBe(true);
    // The deferred steer must not cancel the live run; it queues and rides
    // the next turn boundary instead of forcing an interrupt.
    expect(
      request.mock.calls.some(([type]) => type === "cukii/cancelBridgeRun"),
    ).toBe(false);
    const steer = sessionOf(store).history.find((item) => item.isSteer);
    expect(steer?.steerStatus).toBe("queued");
    expect(streams).toHaveLength(0);

    // The stale run settles; the drain redelivers through the new vendor.
    store.dispatch(setInactive());
    await store.dispatch(continueIfTrailingSteer() as any);

    expect(streams).toHaveLength(1);
    expect(streams[0].brokerModel).toBe("codex-5-6-sol");
    expect(streams[0].queuedFollowUpMessageId).toBe(steer?.message.id);
    const delivered = sessionOf(store).history.find(
      (item) => item.message.id === steer?.message.id,
    );
    expect(delivered?.steerStatus).toBe("read");
  });
});
