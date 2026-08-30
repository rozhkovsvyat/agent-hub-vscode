import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchResponseEscape } from "./chatEscape";

const escape = (init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", {
    key: "Escape",
    cancelable: true,
    bubbles: true,
    ...init,
  });

describe("active response Escape", () => {
  afterEach(() => document.body.replaceChildren());

  it("dispatches the existing cancelStream path exactly once for a held key", () => {
    const dispatchCancelStream = vi.fn();
    expect(dispatchResponseEscape(escape(), true, dispatchCancelStream)).toBe(true);
    expect(
      dispatchResponseEscape(escape({ repeat: true }), true, dispatchCancelStream),
    ).toBe(false);
    expect(dispatchCancelStream).toHaveBeenCalledTimes(1);
  });

  it("does nothing while idle or while an IME composition owns Escape", () => {
    const dispatchCancelStream = vi.fn();
    dispatchResponseEscape(escape(), false, dispatchCancelStream);
    dispatchResponseEscape(escape({ isComposing: true }), true, dispatchCancelStream);
    expect(dispatchCancelStream).not.toHaveBeenCalled();
  });

  it.each(["menu", "dialog", "listbox"])(
    "lets a visible %s consume Escape before cancellation",
    (role) => {
      const overlay = document.createElement("div");
      overlay.setAttribute("role", role);
      document.body.append(overlay);
      const dispatchCancelStream = vi.fn();
      expect(dispatchResponseEscape(escape(), true, dispatchCancelStream)).toBe(false);
      expect(dispatchCancelStream).not.toHaveBeenCalled();
    },
  );

  it("ignores a hidden menu and dispatches cancellation", () => {
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    document.body.append(menu);
    const dispatchCancelStream = vi.fn();
    dispatchResponseEscape(escape(), true, dispatchCancelStream);
    expect(dispatchCancelStream).toHaveBeenCalledTimes(1);
  });
});
