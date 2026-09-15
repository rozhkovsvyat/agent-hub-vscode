import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useElementSize } from "./useElementSize";

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  observe() {}
  unobserve() {}

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

describe("useElementSize", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("cancels the pending resize update when the consumer unmounts", () => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientWidth: { value: 320 },
      clientHeight: { value: 180 },
      scrollWidth: { value: 321 },
      scrollHeight: { value: 181 },
    });
    const ref = { current: element };
    const { result, unmount } = renderHook(() => useElementSize(ref, 250));

    expect(result.current.isResizing).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    act(() => ResizeObserverMock.instances[0].emit());
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(ResizeObserverMock.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => vi.runAllTimers()).not.toThrow();
  });
});
