import { describe, expect, it, vi } from "vitest";

import { resolveWithBoundedRetry } from "./bindingRetry";

describe("resolveWithBoundedRetry", () => {
  it("survives the vendor-spawn to run-binding registration race", async () => {
    const expected = { runId: "run-a" };
    const resolve = vi
      .fn<() => typeof expected | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(expected);
    const sleep = vi.fn(async () => undefined);

    await expect(
      resolveWithBoundedRetry(resolve, { attempts: 5, sleep }),
    ).resolves.toEqual(expected);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns undefined after the bounded wait", async () => {
    const sleep = vi.fn(async () => undefined);
    await expect(
      resolveWithBoundedRetry(() => undefined, { attempts: 3, sleep }),
    ).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
