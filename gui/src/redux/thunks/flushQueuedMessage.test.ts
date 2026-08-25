import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { describe, expect, it } from "vitest";
import { RootState } from "../store";
import { createMockStore } from "../../util/test/mockStore";
import {
  setActive,
  setIsInEdit,
  setQueuedMessage,
} from "../slices/sessionSlice";
import { flushQueuedMessage } from "./flushQueuedMessage";

const editorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "queued follow-up" }],
    },
  ],
};

const modifiers: InputModifiers = { useCodebase: false, noContext: true };

function sessionOf(store: ReturnType<typeof createMockStore>) {
  return (store.getState() as RootState).session;
}

function enqueue(store: ReturnType<typeof createMockStore>) {
  store.dispatch(
    setQueuedMessage({
      editorState,
      modifiers,
      preview: "queued follow-up",
    }),
  );
}

describe("flushQueuedMessage", () => {
  it("no-ops when the slot is empty", async () => {
    const store = createMockStore();
    await store.dispatch(flushQueuedMessage() as any);
    expect(sessionOf(store).queuedMessage).toBeUndefined();
    expect(sessionOf(store).isStreaming).toBe(false);
  });

  it("no-ops while streaming", async () => {
    const store = createMockStore();
    enqueue(store);
    store.dispatch(setActive());
    await store.dispatch(flushQueuedMessage() as any);
    expect(sessionOf(store).queuedMessage?.preview).toBe("queued follow-up");
  });

  it("no-ops in edit mode", async () => {
    const store = createMockStore();
    enqueue(store);
    store.dispatch(setIsInEdit(true));
    await store.dispatch(flushQueuedMessage() as any);
    expect(sessionOf(store).queuedMessage?.preview).toBe("queued follow-up");
  });

  it("clears the slot when idle", async () => {
    const store = createMockStore();
    enqueue(store);
    await store.dispatch(flushQueuedMessage() as any);
    expect(sessionOf(store).queuedMessage).toBeUndefined();
  });
});
