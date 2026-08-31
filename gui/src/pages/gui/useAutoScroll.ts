import { useEffect, useLayoutEffect, useRef } from "react";
import { ChatHistoryItemWithMessageId } from "../../redux/slices/sessionSlice";

// Claude Code webview uses this exact strict (<) distance to keep the transcript
// latched to its bottom. Keeping it here avoids a fractional scroll position
// accidentally detaching an otherwise-following conversation.
export const CLAUDE_FOLLOW_SCROLL_THRESHOLD_PX = 50;

function isNearBottom(element: HTMLDivElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <
    CLAUDE_FOLLOW_SCROLL_THRESHOLD_PX
  );
}

function getUserMessageCount(history: ChatHistoryItemWithMessageId[]) {
  return history.filter((item) => item.message.role === "user").length;
}

export const useAutoScroll = (
  ref: React.RefObject<HTMLDivElement>,
  history: ChatHistoryItemWithMessageId[],
  isStreaming: boolean,
  sessionId: string,
) => {
  const followsBottomRef = useRef(true);
  const previousSessionIdRef = useRef<string>();
  const previousUserMessageCountRef = useRef(0);

  const scrollToBottom = () => {
    const element = ref.current;
    if (!element || !followsBottomRef.current) {
      return;
    }

    if (!isNearBottom(element)) {
      element.scrollTop = element.scrollHeight;
    }
  };

  // This is a layout effect so a newly inserted user/assistant/tool block is
  // already visible in the same paint, rather than waiting for ResizeObserver.
  useLayoutEffect(() => {
    const userMessageCount = getUserMessageCount(history);
    const hasNewUserMessage =
      userMessageCount > previousUserMessageCountRef.current;
    const hasNewSession =
      previousSessionIdRef.current !== undefined &&
      previousSessionIdRef.current !== sessionId;

    if (hasNewUserMessage || hasNewSession) {
      followsBottomRef.current = true;
    }

    previousSessionIdRef.current = sessionId;
    previousUserMessageCountRef.current = userMessageCount;
    scrollToBottom();
  }, [history, isStreaming, sessionId]);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    let animationFrame: number | undefined;
    const scheduleFollow = () => {
      if (!followsBottomRef.current || animationFrame !== undefined) {
        return;
      }

      animationFrame = requestAnimationFrame(() => {
        animationFrame = undefined;
        scrollToBottom();
      });
    };

    const handleScroll = () => {
      followsBottomRef.current = isNearBottom(element);
    };

    const resizeObserver = new ResizeObserver(scheduleFollow);
    const observeChild = (child: Element) => resizeObserver.observe(child);
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            observeChild(node);
          }
        });
      }
      scheduleFollow();
    });

    element.addEventListener("scroll", handleScroll, { passive: true });
    resizeObserver.observe(element);
    Array.from(element.children).forEach(observeChild);
    mutationObserver.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => {
      if (animationFrame !== undefined) {
        cancelAnimationFrame(animationFrame);
      }
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      element.removeEventListener("scroll", handleScroll);
    };
  }, [ref]);
};
