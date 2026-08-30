import { describe, expect, it } from "vitest";

import { shouldInterruptFromEscape } from "./interruptShortcut";

const clearRoot = { querySelector: () => null };
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
    expect(shouldInterruptFromEscape(escape(), active, clearRoot)).toBe(true);
  });

  it.each([
    ["idle", { ...active, isStreaming: false }, escape(), clearRoot],
    ["repeat", active, escape({ repeat: true }), clearRoot],
    ["IME", active, escape({ isComposing: true }), clearRoot],
    [
      "permission",
      { ...active, hasPendingPermission: true },
      escape(),
      clearRoot,
    ],
    [
      "already cancelling",
      { ...active, isCancelling: true },
      escape(),
      clearRoot,
    ],
    [
      "open overlay",
      active,
      escape(),
      { querySelector: () => ({}) as Element },
    ],
  ])("guards %s", (_name, state, event, root) => {
    expect(shouldInterruptFromEscape(event, state, root)).toBe(false);
  });
});
