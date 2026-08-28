import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));
vi.mock("./util/errorHandling", () => ({ handleLLMError: vi.fn() }));

import { VsCodeWebviewProtocol } from "./webviewProtocol";

describe("webview protocol disposal", () => {
  it("propagates disposal authority to a cloned panel protocol", () => {
    const source = new VsCodeWebviewProtocol();
    let disposed: VsCodeWebviewProtocol | undefined;
    source.onDispose((protocol) => {
      disposed = protocol;
    });
    const panel = source.cloneHandlers();
    panel.dispose();
    expect(disposed).toBe(panel);
  });
});
