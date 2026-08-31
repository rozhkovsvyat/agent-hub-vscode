import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "core";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  abortStream,
  type ChatHistoryItemWithMessageId,
  newSession,
  setBrokerPermissionMode,
  setActive,
  setInactive,
  streamUpdate,
} from "../slices/sessionSlice";
import { setupStore } from "../store";
import {
  isSameTerminalError,
  streamBrokerBridgeInput,
} from "./streamBrokerBridgeInput";

function messageWithId<T extends ChatMessage>(
  message: T,
  id: string,
): T & { id: string } {
  return { ...message, id };
}

describe("streamBrokerBridgeInput controls", () => {
  it("keeps a queued follow-up pending until factual vendor activity, then persists read", async () => {
    const ideMessenger = new MockIdeMessenger();
    const request = vi.spyOn(ideMessenger, "request");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let localConsumed!: () => void;
    const consumed = new Promise<void>((resolve) => (localConsumed = resolve));
    ideMessenger.streamRequest = vi.fn(async function* () {
      yield [{ role: "thinking", content: "Launching native command" }];
      localConsumed();
      await blocked;
      yield [
        {
          role: "thinking",
          content: "Native bridge first output",
          cukiiVendorActivity: true,
        },
      ];
      yield [{ role: "assistant", content: "", cukiiTerminal: true }];
    }) as typeof ideMessenger.streamRequest;
    const followUp: ChatHistoryItemWithMessageId = {
      message: messageWithId(
        { role: "user", content: "wait for acceptance" },
        "activity-follow-up",
      ),
      contextItems: [],
      isSteer: true,
      steerStatus: "deferred",
      steerSentAt: 1,
      messageReceipt: { sentAt: 1, status: "deferred" },
    };
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "activity-receipt",
        title: "Activity receipt",
        workspaceDirectory: "D:/Brain/vault",
        history: [followUp],
        mode: "broker",
        brokerModel: "qwen-3-8-max",
      }),
    );

    const running = store.dispatch(
      streamBrokerBridgeInput({
        queuedFollowUpMessageId: "activity-follow-up",
      }),
    );
    await consumed;
    expect(store.getState().session.history[0].steerStatus).toBe("deferred");
    release();
    await running;

    expect(store.getState().session.history[0].steerStatus).toBe("read");
    expect(
      request.mock.calls
        .filter(([type]) => type === "history/save")
        .some(([, saved]) =>
          (saved as any).history.some(
            (entry: ChatHistoryItemWithMessageId) =>
              entry.message.id === "activity-follow-up" &&
              entry.steerStatus === "read",
          ),
        ),
    ).toBe(true);
  });

  it("dispatches exactly one claimed queued follow-up as the final FIFO user turn", async () => {
    const ideMessenger = new MockIdeMessenger();
    const captured: any[] = [];
    ideMessenger.streamRequest = vi.fn(async function* (_messageType, data) {
      captured.push(data);
      yield [
        {
          role: "assistant",
          content: "",
          cukiiSteerReadMessageId: "follow-up-1",
        },
      ];
      yield [{ role: "assistant", content: "accepted", cukiiTerminal: true }];
    }) as typeof ideMessenger.streamRequest;
    const history: ChatHistoryItemWithMessageId[] = [
      {
        message: messageWithId(
          { role: "user", content: "original" },
          "original",
        ),
        contextItems: [],
      },
      {
        message: messageWithId(
          { role: "user", content: "first queued" },
          "follow-up-1",
        ),
        contextItems: [],
        isSteer: true,
        steerStatus: "deferred",
        steerSentAt: 1,
      },
      {
        message: messageWithId(
          { role: "assistant", content: "old turn ended" },
          "old-assistant",
        ),
        contextItems: [],
      },
      {
        message: messageWithId(
          { role: "user", content: "second queued" },
          "follow-up-2",
        ),
        contextItems: [],
        isSteer: true,
        steerStatus: "deferred",
        steerSentAt: 2,
      },
    ];
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "fifo",
        title: "FIFO",
        workspaceDirectory: "D:/Brain/vault",
        history,
        brokerModel: "qwen-3-8-max",
      }),
    );

    await store.dispatch(
      streamBrokerBridgeInput({ queuedFollowUpMessageId: "follow-up-1" }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].queuedFollowUpMessageId).toBe("follow-up-1");
    expect(
      captured[0].messages.map(
        (message: ChatMessage & { id?: string }) => message.id,
      ),
    ).toEqual(["original", "old-assistant", "follow-up-1"]);
    expect(
      store
        .getState()
        .session.history.find((item) => item.message.id === "follow-up-1")
        ?.steerStatus,
    ).toBe("read");
  });

  it("normalizes terminal error decoration and repeated frames without merging distinct errors", () => {
    expect(
      isSameTerminalError(
        { role: "assistant", content: "⚠️ Error: session limit reached" },
        {
          role: "assistant",
          content: "session limit reachedsession limit reached",
        },
      ),
    ).toBe(true);
    expect(
      isSameTerminalError(
        { role: "assistant", content: "session limit reached" },
        { role: "assistant", content: "authentication expired" },
      ),
    ).toBe(false);
  });

  it("merge contract: activity is not terminal; inactive, abort, and new session reset streaming", async () => {
    const store = setupStore({ ideMessenger: new MockIdeMessenger() });
    store.dispatch(
      newSession({
        sessionId: "wait-contract",
        title: "Wait contract",
        workspaceDirectory: "D:/Scratch/cukii-interrupt-terminal-2.0.67",
        history: [
          {
            message: { role: "user", content: "Start" },
            contextItems: [],
          },
        ],
      }),
    );

    // Integrators union their wait signal with bridge completion; ordinary
    // activity stays active until an explicit reset arrives.
    store.dispatch(setActive());
    store.dispatch(streamUpdate([{ role: "assistant", content: "Working" }]));
    expect(store.getState().session.isStreaming).toBe(true);

    store.dispatch(setInactive());
    expect(store.getState().session.isStreaming).toBe(false);
    store.dispatch(setActive());
    store.dispatch(abortStream());
    expect(store.getState().session.isStreaming).toBe(false);
    store.dispatch(setActive());
    store.dispatch(newSession(undefined));
    expect(store.getState().session.isStreaming).toBe(false);
  });

  it("never settles a replacement session from a stale terminal receipt", async () => {
    const ideMessenger = new MockIdeMessenger();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    ideMessenger.streamRequest = vi.fn(async function* () {
      await blocked;
      yield [{ role: "assistant", content: "", cukiiTerminal: true }];
    }) as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "old-run",
        title: "Old",
        workspaceDirectory: "D:/Brain/vault",
        history: [
          {
            message: messageWithId(
              { role: "user", content: "old request" },
              "old-user",
            ),
            contextItems: [],
          },
        ],
        mode: "broker",
      }),
    );
    const running = store.dispatch(streamBrokerBridgeInput());
    await vi.waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(true),
    );
    store.dispatch(
      newSession({
        sessionId: "replacement",
        title: "Replacement",
        workspaceDirectory: "D:/Brain/vault",
        history: [],
        mode: "broker",
      }),
    );
    store.dispatch(setActive());

    release();
    await running;

    expect(store.getState().session.id).toBe("replacement");
    expect(store.getState().session.isStreaming).toBe(true);
    // Let the losing cancellation-race poller settle before Vitest exits.
    store.dispatch(setInactive());
  });

  it("sends a switched Manual permission mode and this tab's controls in the bridge request", async () => {
    const ideMessenger = new MockIdeMessenger();
    const captured: Array<{ messageType: string; data: unknown }> = [];
    ideMessenger.streamRequest = vi.fn(async function* (messageType, data) {
      captured.push({ messageType: String(messageType), data });
      return undefined;
    }) as typeof ideMessenger.streamRequest;

    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "terra-medium-fast",
        title: "Terra medium",
        workspaceDirectory: "D:/Brain/vault",
        history: [
          {
            message: { role: "user", content: "Check controls" },
            contextItems: [],
          },
        ],
        brokerModel: "codex-5-6-terra",
        brokerSubagent: "auto",
        brokerEffort: "medium",
        brokerSpeed: "fast",
        hasReasoningEnabled: false,
        brokerPermissionMode: "manual",
      }),
    );
    store.dispatch(setBrokerPermissionMode("plan"));

    await store.dispatch(streamBrokerBridgeInput());

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      messageType: "cukii/streamBridgeChat",
      data: expect.objectContaining({
        brokerModel: "codex-5-6-terra",
        brokerSubagent: "auto",
        brokerEffort: "medium",
        brokerSpeed: "fast",
        thinkingEnabled: false,
        brokerPermissionMode: "plan",
      }),
    });
  });

  it("keeps a blank-tab permission draft through its first send without persisting a sidebar entry", async () => {
    const ideMessenger = new MockIdeMessenger();
    const captured: unknown[] = [];
    ideMessenger.streamRequest = vi.fn(async function* (_messageType, data) {
      captured.push(data);
      return undefined;
    }) as typeof ideMessenger.streamRequest;

    const store = setupStore({ ideMessenger });
    store.dispatch(newSession(undefined));
    store.dispatch(setBrokerPermissionMode("bypass"));
    expect(store.getState().session.history).toHaveLength(0);
    expect(store.getState().session.allSessionMetadata).toHaveLength(0);

    // The normal submit path has already placed the first user message in
    // state when the streaming thunk reads the per-tab draft.
    store.dispatch(
      streamUpdate([{ role: "user", content: "Use the selected mode" }]),
    );
    await store.dispatch(streamBrokerBridgeInput());

    expect(captured).toEqual([
      expect.objectContaining({ brokerPermissionMode: "bypass" }),
    ]);
    expect(store.getState().session.allSessionMetadata).toHaveLength(0);
  });

  it("keeps the initial receipt at one check until factual vendor activity and omits a model-switch receipt from the request", async () => {
    const ideMessenger = new MockIdeMessenger();
    const captured: unknown[] = [];
    let emitVendorActivity!: () => void;
    const vendorActivity = new Promise<void>((resolve) => {
      emitVendorActivity = resolve;
    });
    ideMessenger.streamRequest = vi.fn(async function* (_messageType, data) {
      captured.push(data);
      yield [{ role: "thinking", content: "Launching native command" }];
      await vendorActivity;
      yield [
        {
          role: "thinking",
          content: "Native bridge first output after 0.1 s.",
          cukiiVendorActivity: true,
        },
      ];
      yield [{ role: "assistant", content: "", cukiiTerminal: true }];
    }) as typeof ideMessenger.streamRequest;

    const history: ChatHistoryItemWithMessageId[] = [
      {
        message: messageWithId({ role: "system", content: "" }, "switch"),
        contextItems: [],
        modelSwitch: {
          model: "codex-5-6-terra",
          displayName: "GPT-5.6 Terra",
        },
      },
      {
        message: messageWithId({ role: "user", content: "Run it" }, "prompt"),
        contextItems: [],
        messageReceipt: { sentAt: 1_700_000_000_000, status: "queued" },
      },
    ];
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "receipt-activity",
        title: "Receipt activity",
        workspaceDirectory: "D:/Scratch/cukii-release-2.0.67",
        history,
      }),
    );

    const running = store.dispatch(streamBrokerBridgeInput());
    await vi.waitFor(() =>
      expect(store.getState().session.history.at(-1)?.reasoning?.text).toBe(
        "Launching native command",
      ),
    );
    expect(store.getState().session.history[1].messageReceipt?.status).toBe(
      "delivered",
    );
    emitVendorActivity();
    await running;

    expect(store.getState().session.history[1].messageReceipt?.status).toBe(
      "read",
    );
    expect(captured).toEqual([
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "user", content: "Run it" }),
        ],
      }),
    ]);
  });

  it("awaits generator return when Stop cancels a live bridge", async () => {
    const ideMessenger = new MockIdeMessenger();
    const returned = vi.fn(async () => ({ done: true, value: undefined }));
    ideMessenger.streamRequest = vi.fn(() => ({
      next: () => new Promise(() => {}),
      return: returned,
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    })) as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(newSession(undefined));
    const running = store.dispatch(streamBrokerBridgeInput());
    await vi.waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(true),
    );
    store.dispatch(abortStream());
    await running;
    expect(returned).toHaveBeenCalled();
    expect(store.getState().session.isStreaming).toBe(false);
  });

  it("ignores a stale completion that arrives after cancellation", async () => {
    const ideMessenger = new MockIdeMessenger();
    let complete!: (value: IteratorResult<any[], undefined>) => void;
    const next = new Promise<IteratorResult<any[], undefined>>(
      (resolve) => (complete = resolve),
    );
    ideMessenger.streamRequest = vi.fn(() => ({
      next: () => next,
      return: vi.fn(async () => ({ done: true, value: undefined })),
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    })) as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(newSession(undefined));
    const running = store.dispatch(streamBrokerBridgeInput());
    await vi.waitFor(() =>
      expect(store.getState().session.isStreaming).toBe(true),
    );
    store.dispatch(abortStream());
    complete({ done: false, value: [{ role: "assistant", content: "stale" }] });
    await running;
    expect(store.getState().session.history).toHaveLength(0);
  });

  it("keeps activity for assistant text but dismisses it on an explicit terminal receipt", async () => {
    const ideMessenger = new MockIdeMessenger();
    let nextCall = 0;
    let emitTerminal!: (value: IteratorResult<any[], undefined>) => void;
    const terminal = new Promise<IteratorResult<any[], undefined>>(
      (resolve) => (emitTerminal = resolve),
    );
    const returned = vi.fn(async () => ({ done: true, value: undefined }));
    ideMessenger.streamRequest = vi.fn(() => ({
      next: async () => {
        nextCall += 1;
        if (nextCall === 1) {
          return {
            done: false,
            value: [{ role: "assistant", content: "Final-looking text" }],
          };
        }
        return terminal;
      },
      return: returned,
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    })) as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "terminal-receipt",
        title: "Terminal receipt",
        workspaceDirectory: "D:/Scratch/cukii-interrupt-terminal-2.0.67",
        history: [
          {
            message: { role: "user", content: "Start native bridge" },
            contextItems: [],
          },
        ],
      }),
    );

    const running = store.dispatch(streamBrokerBridgeInput());
    await vi.waitFor(() =>
      expect(store.getState().session.history.at(-1)?.message.content).toBe(
        "Final-looking text",
      ),
    );
    expect(store.getState().session.isStreaming).toBe(true);
    emitTerminal({
      done: false,
      value: [{ role: "assistant", content: "", cukiiTerminal: true }],
    });
    await running;

    expect(store.getState().session.isStreaming).toBe(false);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(
      store.getState().session.history.filter((item) => item.interrupted),
    ).toHaveLength(0);
  });

  it("clears an explicit wait receipt when the same bridge turn becomes terminal", async () => {
    const ideMessenger = new MockIdeMessenger();
    let nextCall = 0;
    let emitTerminal!: (value: IteratorResult<any[], undefined>) => void;
    const terminal = new Promise<IteratorResult<any[], undefined>>(
      (resolve) => (emitTerminal = resolve),
    );
    const returned = vi.fn(async () => ({ done: true, value: undefined }));
    ideMessenger.streamRequest = vi.fn(() => ({
      next: async () => {
        nextCall += 1;
        if (nextCall === 1) {
          return {
            done: false,
            value: [
              {
                role: "thinking",
                content: "",
                cukiiBridgeWait: { condition: "native sleep" },
              },
            ],
          };
        }
        return terminal;
      },
      return: returned,
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    })) as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(newSession(undefined));

    const running = store.dispatch(streamBrokerBridgeInput());
    await vi.waitFor(() =>
      expect(store.getState().session.bridgeWait).toEqual({
        condition: "native sleep",
      }),
    );
    emitTerminal({
      done: false,
      value: [{ role: "assistant", content: "", cukiiTerminal: true }],
    });
    await running;

    expect(store.getState().session.bridgeWait).toBeUndefined();
    expect(store.getState().session.isStreaming).toBe(false);
    expect(store.getState().session.history).toHaveLength(0);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it("renders a repeated native terminal error once and ignores late frames", async () => {
    const ideMessenger = new MockIdeMessenger();
    const limit =
      "You've hit your session limit · resets 3:30am (Europe/Moscow)";
    const returned = vi.fn(async () => ({ done: true, value: undefined }));
    ideMessenger.streamRequest = vi.fn(() => ({
      next: vi.fn(async () => ({
        done: false,
        value: [
          { role: "assistant", content: `  ${limit}  ` },
          {
            role: "assistant",
            content: `\n\n⚠️ Error: ${limit}\n`,
            cukiiTerminalError: true,
          },
          {
            role: "assistant",
            content: `${limit}${limit}`,
            cukiiTerminalError: true,
          },
          { role: "assistant", content: "", cukiiTerminal: true },
          {
            role: "assistant",
            content: `Warning: ${limit}`,
            cukiiTerminalError: true,
          },
        ],
      })),
      return: returned,
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    })) as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "terminal-error-dedup",
        title: "Terminal error dedup",
        workspaceDirectory: "D:/Scratch/cukii-release-2.0.67",
        history: [
          {
            message: { role: "user", content: "Start native bridge" },
            contextItems: [],
          },
        ],
      }),
    );

    await store.dispatch(streamBrokerBridgeInput());

    const assistantText = store
      .getState()
      .session.history.filter((item) => item.message.role === "assistant")
      .map((item) => String(item.message.content))
      .join("");
    expect(assistantText).toBe(`  ${limit}  `);
    expect(store.getState().session.isStreaming).toBe(false);
    expect(returned).toHaveBeenCalledTimes(1);
    expect(
      store.getState().session.history.filter((item) => item.interrupted),
    ).toHaveLength(0);
  });

  it("suppresses a terminal receipt without mutating prior assistant text", async () => {
    const ideMessenger = new MockIdeMessenger();
    const prior = "  Error: Disk full  ";
    ideMessenger.streamRequest = vi.fn(() => ({
      next: vi.fn(async () => ({
        done: false,
        value: [
          { role: "assistant", content: prior },
          {
            role: "assistant",
            content: "Disk full",
            cukiiTerminalError: true,
          },
        ],
      })),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    })) as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "terminal-error-prior-text",
        title: "Terminal error prior text",
        workspaceDirectory: "D:/Scratch/cukii-release-2.0.67",
        history: [
          {
            message: { role: "user", content: "Start native bridge" },
            contextItems: [],
          },
        ],
      }),
    );

    await store.dispatch(streamBrokerBridgeInput());

    expect(store.getState().session.history.at(-1)?.message.content).toBe(
      prior,
    );
  });

  it("allows the same terminal error once in a subsequent run", async () => {
    const ideMessenger = new MockIdeMessenger();
    const terminalError = "Native broker stopped";
    ideMessenger.streamRequest = vi.fn(() => ({
      next: vi.fn(async () => ({
        done: false,
        value: [
          {
            role: "assistant",
            content: `Warning: ${terminalError}`,
            cukiiTerminalError: true,
          },
        ],
      })),
      return: vi.fn(async () => ({ done: true, value: undefined })),
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    })) as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "terminal-error-next-run",
        title: "Terminal error next run",
        workspaceDirectory: "D:/Scratch/cukii-release-2.0.67",
        history: [
          {
            message: { role: "user", content: "First run" },
            contextItems: [],
          },
        ],
      }),
    );

    await store.dispatch(streamBrokerBridgeInput());
    store.dispatch(streamUpdate([{ role: "user", content: "Second run" }]));
    await store.dispatch(streamBrokerBridgeInput());

    expect(
      store
        .getState()
        .session.history.filter((item) => item.message.role === "assistant"),
    ).toHaveLength(2);
  });
});
