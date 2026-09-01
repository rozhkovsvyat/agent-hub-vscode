import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import {
  createMockStore,
  getEmptyRootState,
} from "../../util/test/mockStore";
import { setActive, setInactive } from "../slices/sessionSlice";
import { RootState } from "../store";
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

  it("interrupts an in-flight run to redeliver when the vendor defers steering", async () => {
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

    // The vendor cannot accept the steer live, so the run is interrupted to
    // redeliver it promptly instead of waiting for the turn to end on its own.
    expect(
      request.mock.calls.some(([type]) => type === "cukii/cancelBridgeRun"),
    ).toBe(true);
    // The durable follow-up must survive the interrupt; only an explicit user
    // Stop may cancel it. Leaving it deferred keeps it eligible for redelivery.
    const steer = sessionOf(store).history.find((item) => item.isSteer);
    expect(steer?.steerStatus).not.toBe("cancelled");
  });

  it("redelivers through a fresh turn when the live run disappears during steering", async () => {
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

    await vi.waitFor(() => expect(redelivered).toHaveLength(1));
    expect(
      request.mock.calls.some(([type]) => type === "cukii/cancelBridgeRun"),
    ).toBe(true);
    const steer = sessionOf(store).history.find((item) => item.isSteer);
    expect(redelivered).toEqual([steer?.message.id]);
    expect(steer?.steerStatus).toBe("read");
    expect(steer?.messageReceipt?.status).toBe("read");
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
