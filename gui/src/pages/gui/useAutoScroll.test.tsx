import { act, renderHook } from "@testing-library/react";
import { RefObject } from "react";
import { vi } from "vitest";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";
import {
  CLAUDE_FOLLOW_SCROLL_THRESHOLD_PX,
  useAutoScroll,
} from "./useAutoScroll";

type ScrollFixture = {
  element: HTMLDivElement;
  setGeometry: (geometry: {
    clientHeight?: number;
    scrollHeight?: number;
    scrollTop?: number;
  }) => void;
};

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function message(id: string, role: "user" | "assistant" = "assistant") {
  return {
    message: { id, role, content: id },
    contextItems: [],
  } as ChatHistoryItemWithMessageId;
}

function createScrollFixture(): ScrollFixture {
  const element = document.createElement("div");
  const geometry = { clientHeight: 100, scrollHeight: 1000, scrollTop: 900 };

  Object.defineProperties(element, {
    clientHeight: {
      configurable: true,
      get: () => geometry.clientHeight,
    },
    scrollHeight: {
      configurable: true,
      get: () => geometry.scrollHeight,
    },
    scrollTop: {
      configurable: true,
      get: () => geometry.scrollTop,
      set: (value: number) => {
        geometry.scrollTop = value;
      },
    },
  });

  return {
    element,
    setGeometry: (next) => Object.assign(geometry, next),
  };
}

function useFixture(
  fixture: ScrollFixture,
  history: ChatHistoryItemWithMessageId[],
  isStreaming = false,
  sessionId = "session-1",
) {
  return renderHook(
    ({ nextHistory, nextIsStreaming, nextSessionId }) =>
      useAutoScroll(
        { current: fixture.element } as RefObject<HTMLDivElement>,
        nextHistory,
        nextIsStreaming,
        nextSessionId,
      ),
    {
      initialProps: {
        nextHistory: history,
        nextIsStreaming: isStreaming,
        nextSessionId: sessionId,
      },
    },
  );
}

beforeEach(() => {
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
    callback(0);
    return 1;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("follows initial, queued user, and streaming updates immediately", () => {
  const fixture = createScrollFixture();
  const initial = [message("user-1", "user"), message("assistant-1")];
  const hook = useFixture(fixture, initial);

  fixture.setGeometry({ scrollHeight: 1200, scrollTop: 900 });
  hook.rerender({
    nextHistory: [...initial, message("user-2", "user")],
    nextIsStreaming: false,
    nextSessionId: "session-1",
  });
  expect(fixture.element.scrollTop).toBe(1200);

  fixture.setGeometry({ scrollHeight: 1450, scrollTop: 1200 });
  hook.rerender({
    nextHistory: [...initial, message("user-2", "user"), message("tool-1")],
    nextIsStreaming: true,
    nextSessionId: "session-1",
  });
  expect(fixture.element.scrollTop).toBe(1450);
});

test("RED: manual scroll-up stays put until strictly inside Claude's 50px latch", () => {
  const fixture = createScrollFixture();
  useFixture(fixture, [message("user", "user"), message("assistant")], true);
  const observer = ResizeObserverMock.instances[0];

  fixture.setGeometry({ scrollTop: 500, scrollHeight: 1000 });
  act(() => fixture.element.dispatchEvent(new Event("scroll")));
  fixture.setGeometry({ scrollHeight: 1250 });
  act(() => observer.trigger());
  expect(fixture.element.scrollTop).toBe(500);

  fixture.setGeometry({ scrollTop: 1100 });
  act(() => fixture.element.dispatchEvent(new Event("scroll")));
  fixture.setGeometry({ scrollHeight: 1300 });
  act(() => observer.trigger());
  expect(fixture.element.scrollTop).toBe(1100);

  fixture.setGeometry({
    scrollTop: 1300 - 100 - CLAUDE_FOLLOW_SCROLL_THRESHOLD_PX + 1,
  });
  act(() => fixture.element.dispatchEvent(new Event("scroll")));
  fixture.setGeometry({ scrollHeight: 1500 });
  act(() => observer.trigger());
  expect(fixture.element.scrollTop).toBe(1500);
});

test("resets the latch for a different session and follows dynamic-height blocks", () => {
  const fixture = createScrollFixture();
  const previous = [message("old-user", "user"), message("old-assistant")];
  const hook = useFixture(fixture, previous, true);
  const observer = ResizeObserverMock.instances[0];

  fixture.setGeometry({ scrollTop: 400 });
  act(() => fixture.element.dispatchEvent(new Event("scroll")));
  fixture.setGeometry({ scrollHeight: 1200 });
  hook.rerender({
    nextHistory: [message("new-user", "user"), message("new-thinking")],
    nextIsStreaming: true,
    nextSessionId: "session-2",
  });
  expect(fixture.element.scrollTop).toBe(1200);

  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback) => {
    frames.push(callback);
    return frames.length;
  }));
  fixture.setGeometry({ scrollHeight: 1500, scrollTop: 1200 });
  act(() => {
    observer.trigger();
    observer.trigger();
  });
  expect(frames).toHaveLength(1);
  act(() => frames[0](0));
  expect(fixture.element.scrollTop).toBe(1500);
});

test("resets a released latch after reload", () => {
  const fixture = createScrollFixture();
  const history = [message("user", "user"), message("assistant")];
  const hook = useFixture(fixture, history, true);

  fixture.setGeometry({ scrollTop: 400 });
  act(() => fixture.element.dispatchEvent(new Event("scroll")));
  hook.unmount();

  fixture.setGeometry({ scrollHeight: 1200 });
  useFixture(fixture, history, false);
  expect(fixture.element.scrollTop).toBe(1200);
});
