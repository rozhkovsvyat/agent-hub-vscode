import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { createMockStore } from "../../util/test/mockStore";
import { setActive } from "../slices/sessionSlice";
import { RootState } from "../store";
import { steerDuringStream } from "./steerDuringStream";

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "do it this way instead",
      legacyCommandWithInput: undefined,
    })),
  }),
);

const editorState: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "do it this way instead" }],
    },
  ],
};

const modifiers: InputModifiers = { useCodebase: false, noContext: true };

function sessionOf(store: ReturnType<typeof createMockStore>) {
  return (store.getState() as RootState).session;
}

describe("steerDuringStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("no-ops when idle", async () => {
    const store = createMockStore();
    const post = vi.spyOn(store.mockIdeMessenger, "post");
    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);
    expect(sessionOf(store).history).toHaveLength(0);
    expect(post).not.toHaveBeenCalled();
  });

  it("appends a user message and notifies the native bridge", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const post = vi.spyOn(mockIdeMessenger, "post");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());
    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);
    const history = sessionOf(store).history;
    expect(history.at(-1)?.message.role).toBe("user");
    expect(history.at(-1)?.message.content).toBe("do it this way instead");
    expect(post).toHaveBeenCalledWith("cukii/steerDuringStream", {
      text: "do it this way instead",
    });
  });
});
