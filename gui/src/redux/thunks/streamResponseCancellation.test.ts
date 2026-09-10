import { JSONContent } from "@tiptap/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createMockStore, getEmptyRootState } from "../../util/test/mockStore";
import { abortStream, setInactive } from "../slices/sessionSlice";
import { RootState } from "../store";
import { streamResponseThunk } from "./streamResponse";

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({ resolveEditorContent: vi.fn() }),
);

import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";

const mockResolveEditorContent = vi.mocked(resolveEditorContent);
const editorState: JSONContent = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "slow context" }] },
  ],
};

describe("streamResponse cancellation boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not launch a vendor after Stop during context resolution", async () => {
    let releaseContext!: (value: Awaited<
      ReturnType<typeof resolveEditorContent>
    >) => void;
    mockResolveEditorContent.mockImplementation(
      () => new Promise((resolve) => (releaseContext = resolve)),
    );
    const store = createMockStore(getEmptyRootState());
    const vendor = vi.spyOn(store.mockIdeMessenger, "streamRequest");

    const pending = store.dispatch(
      streamResponseThunk({
        editorState,
        modifiers: { useCodebase: false, noContext: false },
      }) as any,
    );
    await vi.waitFor(() => expect(mockResolveEditorContent).toHaveBeenCalled());

    store.dispatch(setInactive());
    store.dispatch(abortStream());
    releaseContext({
      selectedContextItems: [],
      selectedCode: [],
      content: "slow context",
      legacyCommandWithInput: undefined,
    });
    await pending;

    expect(vendor).not.toHaveBeenCalled();
    expect((store.getState() as RootState).session.isStreaming).toBe(false);
  });
});
