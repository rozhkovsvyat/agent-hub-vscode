import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
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
    const request = vi.spyOn(store.mockIdeMessenger, "request");
    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);
    expect(sessionOf(store).history).toHaveLength(0);
    expect(request).not.toHaveBeenCalled();
  });

  it("appends a user message and notifies the native bridge", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());
    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);
    const history = sessionOf(store).history;
    expect(history.at(-1)?.message.role).toBe("user");
    expect(history.at(-1)?.message.content).toBe("do it this way instead");
    expect(history.at(-1)?.steerStatus).toBe("delivered");
    expect(request).toHaveBeenCalledWith(
      "cukii/steerDuringStream",
      expect.objectContaining({
        messageId: expect.any(String),
        sessionId: sessionOf(store).id,
        content: "do it this way instead",
      }),
    );
  });

  it("keeps image attachments in an active-run steering payload", async () => {
    vi.mocked(resolveEditorContent).mockResolvedValueOnce({
      selectedContextItems: [],
      selectedCode: [],
      content: [
        { type: "text", text: "inspect this" },
        {
          type: "imageUrl",
          imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
        },
      ],
      legacyCommandWithInput: undefined,
    });
    const mockIdeMessenger = new MockIdeMessenger();
    const request = vi.spyOn(mockIdeMessenger, "request");
    const store = createMockStore(undefined, mockIdeMessenger);
    store.dispatch(setActive());

    await store.dispatch(steerDuringStream({ editorState, modifiers }) as any);

    expect(request).toHaveBeenCalledWith(
      "cukii/steerDuringStream",
      expect.objectContaining({
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "imageUrl",
            imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
          },
        ],
      }),
    );
    expect(sessionOf(store).history.at(-1)?.message.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "imageUrl" })]),
    );
  });
});
