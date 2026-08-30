import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  abortStream,
  newSession,
  setBrokerPermissionMode,
  setActive,
  setInactive,
  streamUpdate,
} from "../slices/sessionSlice";
import { setupStore } from "../store";
import { streamBrokerBridgeInput } from "./streamBrokerBridgeInput";

describe("streamBrokerBridgeInput controls", () => {
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

  it("sends this tab's effort and speed in the bridge request", async () => {
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
        brokerPermissionMode: "auto",
      }),
    );

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
        brokerPermissionMode: "auto",
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
  });
});
