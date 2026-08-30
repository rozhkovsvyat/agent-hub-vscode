import { describe, expect, it } from "vitest";
import { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { hasTrailingSteerMessage } from "./continueIfTrailingSteer";

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
    expect(
      hasTrailingSteerMessage({
        history: [
          item("user", "hello"),
          item("assistant", "working"),
          item("user", "do it like Claude", true),
        ],
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
});
