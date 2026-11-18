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

  it("does not repeat a resolver that consumed the common deadline", async () => {
    let clock = 1_000;
    const resolve = vi.fn(() => {
      clock += 8_000;
      return undefined;
    });
    const sleep = vi.fn(async () => undefined);
    await expect(
      resolveWithBoundedRetry(resolve, {
        timeoutMs: 5_000,
        now: () => clock,
        sleep,
      }),
    ).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
