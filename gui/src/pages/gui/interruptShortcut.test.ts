import { describe, expect, it } from "vitest";

import { shouldInterruptFromEscape } from "./interruptShortcut";

const active = {
  isStreaming: true,
  isCancelling: false,
  hasPendingPermission: false,
};

function escape(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Escape",
    repeat: false,
    isComposing: false,
    keyCode: 27,
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("shouldInterruptFromEscape", () => {
  it("allows one unmodified Escape for an active run", () => {
    expect(shouldInterruptFromEscape(escape(), active)).toBe(true);
  });

  it.each([
    ["idle", { ...active, isStreaming: false }, escape()],
    ["repeat", active, escape({ repeat: true })],
    ["IME", active, escape({ isComposing: true })],
    ["permission", { ...active, hasPendingPermission: true }, escape()],
    ["already cancelling", { ...active, isCancelling: true }, escape()],
  ])("guards %s", (_name, state, event) => {
    expect(shouldInterruptFromEscape(event, state)).toBe(false);
  });
});
