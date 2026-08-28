import { describe, expect, it } from "vitest";

import { cukiiComposerPlaceholder } from "./cukiiComposerPlaceholder";
import { CUKII_COMPOSER_EMPTY_MESSAGES } from "./cukiiComposerPlaceholder";

describe("cukiiComposerPlaceholder", () => {
  it("keeps edit mode on the selected-code prompt", () => {
    expect(
      cukiiComposerPlaceholder({
        isInEdit: true,
        isStreaming: false,
        isMainInput: true,
        historyLength: 0,
        sessionId: "session-a",
      }),
    ).toBe("Edit selected code");
  });

  it("queues another message while the main composer is streaming", () => {
    expect(
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: true,
        isMainInput: true,
        historyLength: 2,
        sessionId: "session-a",
      }),
    ).toBe("Queue another message…");
  });

  it("attaches selected editor text only when Cukii is completely unfocused", () => {
    expect(
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: false,
        isMainInput: true,
        historyLength: 1,
        sessionId: "session-a",
        hasActiveEditorSelection: true,
        isComposerFocused: false,
        isWebviewFocused: false,
      }),
    ).toBe("ctrl esc to attach selected text");

    expect(
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: false,
        isMainInput: true,
        historyLength: 1,
        sessionId: "session-a",
        hasActiveEditorSelection: true,
        isComposerFocused: true,
        isWebviewFocused: false,
      }),
    ).toBe("ctrl esc to focus or unfocus Cukii");

    expect(
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: false,
        isMainInput: true,
        historyLength: 1,
        sessionId: "session-a",
        hasActiveEditorSelection: true,
        isComposerFocused: false,
        isWebviewFocused: true,
      }),
    ).toBe("ctrl esc to focus or unfocus Cukii");
  });

  it("keeps edit and busy states ahead of the selection hint", () => {
    expect(
      cukiiComposerPlaceholder({
        isInEdit: true,
        isStreaming: true,
        isMainInput: true,
        historyLength: 1,
        hasActiveEditorSelection: true,
        isComposerFocused: false,
        isWebviewFocused: false,
      }),
    ).toBe("Edit selected code");

    expect(
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: true,
        isMainInput: true,
        historyLength: 1,
        hasActiveEditorSelection: true,
        isComposerFocused: false,
        isWebviewFocused: false,
      }),
    ).toBe("Queue another message…");
  });

  it("shows the focus hint for resumed chats with history", () => {
    expect(
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: false,
        isMainInput: true,
        historyLength: 1,
        sessionId: "session-a",
      }),
    ).toBe("ctrl esc to focus or unfocus Cukii");
  });

  it("does not use the streaming placeholder on non-main inputs", () => {
    const placeholder = cukiiComposerPlaceholder({
      isInEdit: false,
      isStreaming: true,
      isMainInput: false,
      historyLength: 0,
      sessionId: "session-a",
    });

    expect(placeholder).not.toBe("Queue another message…");
    expect(CUKII_COMPOSER_EMPTY_MESSAGES).toContain(placeholder);
  });

  it("selects empty-session copy deterministically from the five prompts", () => {
    const firstPass = Array.from({ length: 200 }, (_, index) =>
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: false,
        isMainInput: true,
        historyLength: 0,
        sessionId: `session-${index}`,
      }),
    );
    const secondPass = Array.from({ length: 200 }, (_, index) =>
      cukiiComposerPlaceholder({
        isInEdit: false,
        isStreaming: false,
        isMainInput: true,
        historyLength: 0,
        sessionId: `session-${index}`,
      }),
    );

    expect(secondPass).toEqual(firstPass);
    expect(new Set(firstPass)).toEqual(new Set(CUKII_COMPOSER_EMPTY_MESSAGES));
    expect(CUKII_COMPOSER_EMPTY_MESSAGES).toHaveLength(5);
  });
});
