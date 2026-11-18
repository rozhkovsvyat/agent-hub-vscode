import { describe, expect, it, vi } from "vitest";

import { IdeMessenger } from "./IdeMessenger";

describe("IdeMessenger.streamRequest cancellation", () => {
  it("settles locally and removes listeners when the extension never replies", async () => {
    const messenger = new IdeMessenger();
    const post = vi
      .spyOn(messenger, "post")
      .mockImplementation(() => undefined);
    const remove = vi.spyOn(window, "removeEventListener");
    const controller = new AbortController();
    const stream = messenger.streamRequest(
      "cukii/streamBridgeChat",
      {} as never,
      controller.signal,
    );

    const pending = stream.next();
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("stream did not settle")), 250),
        ),
      ]),
    ).resolves.toEqual({ done: true, value: undefined });
    expect(post).toHaveBeenCalledWith("abort", undefined, expect.any(String));
    expect(remove).toHaveBeenCalledWith("message", expect.any(Function));
  });
});
