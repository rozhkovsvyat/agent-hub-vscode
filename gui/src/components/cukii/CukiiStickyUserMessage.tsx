import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX = 60;

interface CukiiStickyUserMessageProps {
  bubbleClassName: string;
  children: ReactNode;
  messageId: string;
  metadata?: ReactNode;
}

/**
 * Claude Code keeps each prompt at the top of its turn and folds prompts taller
 * than 60px. Cukii keeps its delivery metadata outside that clipped content so
 * the timestamp and ticks remain visible in both folded and expanded states.
 */
export function CukiiStickyUserMessage({
  bubbleClassName,
  children,
  messageId,
  metadata,
}: CukiiStickyUserMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isCollapsible, setIsCollapsible] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const isCollapsed = isCollapsible && !isExpanded;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const measure = () => {
      const containsVisualAttachment = Boolean(
        content.querySelector("img, video, audio, iframe"),
      );
      const next =
        !containsVisualAttachment &&
        content.scrollHeight > CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX;
      setIsCollapsible(next);
      if (!next) setIsExpanded(false);
    };

    measure();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    resizeObserver?.observe(content);
    if (content.firstElementChild) {
      resizeObserver?.observe(content.firstElementChild);
    }
    content.addEventListener("load", measure, true);

    return () => {
      content.removeEventListener("load", measure, true);
      resizeObserver?.disconnect();
    };
  }, [messageId]);

  const expand = useCallback(() => setIsExpanded(true), []);
  const collapse = useCallback(() => setIsExpanded(false), []);
  const expandFromContent = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!isCollapsed) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest('button, a, input, textarea, select, [role="button"]')
      ) {
        return;
      }
      expand();
    },
    [expand, isCollapsed],
  );

  return (
    <div
      className={`${bubbleClassName} ${
        isCollapsed ? "cukii-user-bubble--collapsed" : ""
      } ${isExpanded ? "cukii-user-bubble--expanded" : ""}`}
      data-cukii-collapsible={isCollapsible ? "true" : undefined}
      data-testid={`cukii-user-bubble-${messageId}`}
    >
      <div
        className={`cukii-user-content-shell ${
          isCollapsed ? "cukii-user-content-shell--clickable" : ""
        }`}
        onClickCapture={expandFromContent}
      >
        <div
          className={`cukii-user-message-content ${
            isCollapsed ? "cukii-user-message-content--collapsed" : ""
          }`}
          ref={contentRef}
        >
          {children}
        </div>
        {isCollapsed && (
          <div aria-hidden="true" className="cukii-user-truncation-gradient" />
        )}
        {isCollapsed && (
          <div className="cukii-user-expand-button-container">
            <button
              aria-expanded="false"
              aria-label="Show more"
              className="cukii-user-expand-button"
              onClick={(event) => {
                event.stopPropagation();
                expand();
              }}
              type="button"
            >
              Show more
            </button>
          </div>
        )}
      </div>
      {isExpanded && isCollapsible && (
        <div className="cukii-user-collapse-button-container">
          <button
            aria-expanded="true"
            aria-label="Show less"
            className="cukii-user-collapse-button"
            onClick={collapse}
            type="button"
          >
            Show less
          </button>
        </div>
      )}
      {metadata}
    </div>
  );
}
