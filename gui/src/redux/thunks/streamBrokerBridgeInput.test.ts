import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../slices/sessionSlice";
import { setupStore } from "../store";
import { streamBrokerBridgeInput } from "./streamBrokerBridgeInput";

describe("streamBrokerBridgeInput controls", () => {
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
      }),
    });
  });
});
