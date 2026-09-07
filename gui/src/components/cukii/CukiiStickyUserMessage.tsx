import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
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
 * than 60px. Cukii keeps the fold toggle and delivery metadata in one compact
 * MAX-style footer so neither state creates a second toolbar row.
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
      </div>
      {isCollapsible ? (
        <div className="cukii-user-fold-footer">
          <button
            aria-expanded={isExpanded}
            aria-label={isExpanded ? "Show less" : "Show more"}
            className="cukii-user-fold-toggle"
            onClick={(event) => {
              event.stopPropagation();
              if (isExpanded) collapse();
              else expand();
            }}
            type="button"
          >
            {isExpanded ? (
              <ChevronUpIcon aria-hidden="true" />
            ) : (
              <ChevronDownIcon aria-hidden="true" />
            )}
          </button>
          {metadata}
        </div>
      ) : (
        metadata
      )}
    </div>
  );
}
