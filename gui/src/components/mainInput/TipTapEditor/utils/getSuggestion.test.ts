import { beforeEach, describe, expect, it, vi } from "vitest";

const destroy = vi.fn();
const tippyProps = vi.hoisted(() => ({ current: undefined as any }));

vi.mock("@tiptap/react", () => ({
  ReactRenderer: class {
    destroy = destroy;
    element = document.createElement("div");
    ref = { onKeyDown: vi.fn(() => false) };
    updateProps = vi.fn();
  },
}));

vi.mock("tippy.js", () => ({
  default: vi.fn((_target, props) => {
    tippyProps.current = props;
    return [
      {
        destroy: vi.fn(),
        hide: () => props.onHide?.(),
        setProps: vi.fn(),
      },
    ];
  }),
}));

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

  it("releases Enter ownership when tippy hides after a click in the editor", () => {
    const onClose = vi.fn();
    const shell = document.createElement("div");
    shell.className = "cukii-input-box";
    const editorDom = document.createElement("div");
    const container = document.createElement("div");
    container.dataset.cukiiTippyContainer = "";
    shell.append(editorDom, container);
    document.body.append(shell);
    const lifecycle = getSlashCommandDropdownOptions(
      { current: [] },
      onClose,
      vi.fn(),
      { request: vi.fn() } as any,
      vi.fn() as any,
      "main",
    ).render();

    lifecycle.onStart({
      editor: { view: { dom: editorDom } },
      clientRect: () => new DOMRect(0, 0, 1, 1),
    });
    expect(container).toHaveAttribute("data-cukii-suggestion-open", "true");

    tippyProps.current.onHide();

    expect(container).not.toHaveAttribute("data-cukii-suggestion-open");
    expect(onClose).toHaveBeenCalledOnce();
    lifecycle.onExit();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
