import type { JSONContent } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { newSession } from "../slices/sessionSlice";
import { setupStore } from "../store";
import { streamResponseThunk } from "./streamResponse";

vi.mock(
  "../../components/mainInput/TipTapEditor/utils/resolveEditorContent",
  () => ({
    resolveEditorContent: vi.fn(async () => ({
      selectedContextItems: [],
      selectedCode: [],
      content: "привет",
      legacyCommandWithInput: undefined,
    })),
  }),
);

const editorState: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "привет" }] }],
};

/**
 * A fresh install has an empty `~/.continue/config.yaml` — Cukii ships no
 * default models because the broker talks to vendor CLIs instead. The chat
 * still refused to send, which is what made a helper agent ask the owner
 * "which model should I write into ~/.continue/config.yaml".
 */
describe("broker chat on a fresh install", () => {
  it("sends without any Continue model configured", async () => {
    const ideMessenger = new MockIdeMessenger();
    const streamRequest = vi.fn(async function* () {
      return {
        cukiiBridgeDisposition: "completed" as const,
        sessionId: "fresh-install",
        runId: "run-1",
      };
    });
    ideMessenger.streamRequest =
      streamRequest as unknown as typeof ideMessenger.streamRequest;
    const store = setupStore({ ideMessenger });
    store.dispatch(
      newSession({
        sessionId: "fresh-install",
        title: "Fresh",
        workspaceDirectory: "D:/Brain/vault",
        history: [],
        mode: "broker",
      }),
    );

    // Precondition: this is the fresh-install shape, not a configured one.
    expect(store.getState().config.config.selectedModelByRole.chat).toBeFalsy();

    await store.dispatch(
      streamResponseThunk({
        editorState,
        modifiers: { noContext: true, useCodebase: false },
      }),
    );

    const errors = store
      .getState()
      .session.history.flatMap((item) => [item.message.content])
      .join(" ");
    expect(errors).not.toContain("No chat model selected");
    expect(streamRequest).toHaveBeenCalled();
  });
});
