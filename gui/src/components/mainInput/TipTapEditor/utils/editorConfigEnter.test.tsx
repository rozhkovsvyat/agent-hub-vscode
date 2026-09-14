import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * `createEditorConfig` builds the TipTap extension list exactly once, on the
 * render that creates the view. With `immediatelyRender: false` that render is
 * the one where `useEditor` still returns `null`, so any value the keyboard
 * shortcuts close over directly — rather than through a ref — is frozen in the
 * state it had before the editor existed. These tests press Enter through the
 * real ProseMirror keymap to keep that class of regression out of the composer.
 */

const harness = vi.hoisted(() => ({
  addRef: { current: vi.fn() },
  state: {
    session: {
      mode: "chat",
      isStreaming: false,
      isCancelling: false,
      isInEdit: false,
      history: [] as unknown[],
    },
    editModeState: { codeToEdit: [] as unknown[] },
  },
}));

vi.mock("../../../../context/SubmenuContextProviders", () => ({
  useSubmenuContextProviders: () => ({ getSubmenuContextItems: () => [] }),
}));

vi.mock("../../../../hooks/useInputHistory", () => ({
  useInputHistory: () => ({
    prevRef: { current: () => undefined },
    nextRef: { current: () => undefined },
    addRef: harness.addRef,
  }),
}));

vi.mock("../../../../redux/hooks", () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector(harness.state),
}));

vi.mock("../../../../redux/selectors", () => ({
  selectUseActiveFile: () => true,
}));

vi.mock("../../../../redux/slices/configSlice", () => ({
  selectSelectedChatModel: () => ({
    provider: "openai",
    model: "gpt-4o",
    title: "gpt-4o",
  }),
}));

vi.mock("../../../../redux/thunks/edit", () => ({
  exitEdit: vi.fn(() => ({ type: "edit/exit" })),
}));

vi.mock("../../../../redux/thunks/steerDuringStream", () => ({
  steerDuringStream: vi.fn(() => ({ type: "session/steer" })),
}));

vi.mock("../../../../redux/thunks/cancelStream", () => ({
  cancelStream: vi.fn(() => ({ type: "session/cancel" })),
}));

vi.mock("./getSuggestion", () => {
  const suggestion = () => ({
    items: async () => [],
    render: () => ({
      onStart: () => {},
      onUpdate: () => {},
      onKeyDown: () => false,
      onExit: () => {},
    }),
  });
  return {
    getContextProviderDropdownOptions: suggestion,
    getSlashCommandDropdownOptions: suggestion,
  };
});

import type { Editor } from "@tiptap/core";

import type { TipTapEditorProps } from "../TipTapEditor";
import { createEditorConfig } from "./editorConfig";

function buildProps(onEnter: TipTapEditorProps["onEnter"]): TipTapEditorProps {
  return {
    availableContextProviders: [],
    availableSlashCommands: [],
    isMainInput: true,
    onEnter,
    historyKey: "chat",
    inputId: "main",
  };
}

function renderComposer(onEnter: TipTapEditorProps["onEnter"]) {
  return renderHook(
    (props: TipTapEditorProps) =>
      createEditorConfig({
        props,
        ideMessenger: { post: vi.fn() } as never,
        dispatch: vi.fn() as never,
        enqueueAttachment: async () => {},
      }),
    { initialProps: buildProps(onEnter) },
  );
}

/** Presses a key through the same path `EditorView` uses for real keydown. */
function pressKey(editor: Editor, key: string): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  return Boolean(
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, event),
    ),
  );
}

async function readyEditor(result: {
  current: { editor: Editor | null };
}): Promise<Editor> {
  await waitFor(() => expect(result.current.editor).not.toBeNull());
  const editor = result.current.editor;
  if (!editor) throw new Error("editor never became available");
  return editor;
}

describe("Enter submits the composer", () => {
  it("sends the typed message on plain Enter", async () => {
    const onEnter = vi.fn();
    const { result } = renderComposer(onEnter);
    const editor = await readyEditor(result);

    editor.commands.setContent("<p>привет</p>");

    expect(pressKey(editor, "Enter")).toBe(true);
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter.mock.calls[0][0]).toMatchObject({ type: "doc" });
  });

  it("sends on Mod-Enter as well", async () => {
    const onEnter = vi.fn();
    const { result } = renderComposer(onEnter);
    const editor = await readyEditor(result);

    editor.commands.setContent("<p>привет</p>");
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(editor.view, event),
    );

    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("keeps working after the composer re-renders with a new handler", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderComposer(first);
    const editor = await readyEditor(result);

    rerender(buildProps(second));
    editor.commands.setContent("<p>привет</p>");
    pressKey(editor, "Enter");

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("stays silent on an empty composer", async () => {
    const onEnter = vi.fn();
    const { result } = renderComposer(onEnter);
    const editor = await readyEditor(result);

    editor.commands.clearContent(true);
    pressKey(editor, "Enter");

    expect(onEnter).not.toHaveBeenCalled();
  });
});
