import { beforeEach, describe, expect, it, vi } from "vitest";

const destroy = vi.fn();

vi.mock("@tiptap/react", () => ({
  ReactRenderer: class {
    destroy = destroy;
    element = document.createElement("div");
    ref = { onKeyDown: vi.fn(() => false) };
    updateProps = vi.fn();
  },
}));

vi.mock("tippy.js", () => ({ default: vi.fn(() => []) }));

import { getSlashCommandDropdownOptions } from "./getSuggestion";

describe("suggestion popup lifecycle", () => {
  beforeEach(() => destroy.mockClear());

  it("stays safe when the editor has no suggestion container", () => {
    const lifecycle = getSlashCommandDropdownOptions(
      { current: [] },
      vi.fn(),
      vi.fn(),
      { request: vi.fn() } as any,
      vi.fn() as any,
      "main",
    ).render();
    const editor = {
      view: { dom: document.createElement("div") },
    } as any;
    const clientRect = () => new DOMRect(0, 0, 1, 1);

    lifecycle.onStart({ editor, clientRect });

    expect(destroy).toHaveBeenCalledOnce();
    expect(() => lifecycle.onUpdate({ editor, clientRect })).not.toThrow();
    expect(
      lifecycle.onKeyDown({
        editor,
        event: new KeyboardEvent("keydown", { key: "Escape" }),
      }),
    ).toBe(false);
    expect(() => lifecycle.onExit()).not.toThrow();
  });
});
