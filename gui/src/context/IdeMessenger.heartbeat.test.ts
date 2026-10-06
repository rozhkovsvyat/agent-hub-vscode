import { describe, expect, it, vi } from "vitest";

import { IdeMessenger } from "./IdeMessenger";

describe("IdeMessenger heartbeat responder", () => {
  function withVscode(run: (postMessage: ReturnType<typeof vi.fn>) => void) {
    const postMessage = vi.fn();
    (globalThis as any).vscode = { postMessage };
    try {
      run(postMessage);
    } finally {
      delete (globalThis as any).vscode;
    }
  }

  it("answers each ping exactly once with the same messageId", () => {
    withVscode((postMessage) => {
      // The module already built the context default; a webview also builds
      // the store's messenger and one per provider render.
      new IdeMessenger();
      new IdeMessenger();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            messageType: "cukii/heartbeat",
            data: undefined,
            messageId: "ping-1",
          },
        }),
      );
      expect(postMessage).toHaveBeenCalledTimes(1);
      const sent = postMessage.mock.calls[0][0];
      expect(sent.messageType).toBe("cukii/heartbeat");
      expect(sent.messageId).toBe("ping-1");
      expect(sent.data).toEqual({ pong: expect.any(Number) });
    });
  });

  it("leaves unrelated host messages to their own handlers", () => {
    withVscode((postMessage) => {
      new IdeMessenger();
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            messageType: "setTheme",
            data: { theme: "dark" },
            messageId: "theme-1",
          },
        }),
      );
      expect(postMessage).not.toHaveBeenCalled();
    });
  });
});
