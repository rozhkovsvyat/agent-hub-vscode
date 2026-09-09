import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX = 20;

interface CukiiStickyUserMessageProps {
  bubbleClassName: string;
  children: ReactNode;
  messageId: string;
  metadata?: ReactNode;
}

/**
 * Long prompts fold to one line only while their row is physically pinned to
 * the transcript top. Cukii keeps the fold toggle and delivery metadata in one
 * compact MAX-style footer so neither state creates a second toolbar row.
 */
export function CukiiStickyUserMessage({
  bubbleClassName,
  children,
  messageId,
  metadata,
}: CukiiStickyUserMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isLongPrompt, setIsLongPrompt] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const isCollapsible = isPinned && isLongPrompt;
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
      setIsLongPrompt(next);
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

  useLayoutEffect(() => {
    const content = contentRef.current;
    const row = content?.closest<HTMLElement>(".cukii-user-row--sticky");
    const transcript = content?.closest<HTMLElement>(".cukii-transcript");
    if (!row || !transcript) return;

    const measurePinned = () => {
      const next =
        transcript.scrollTop > 0 &&
        row.getBoundingClientRect().top <=
          transcript.getBoundingClientRect().top + 1;
      setIsPinned(next);
      if (!next) setIsExpanded(false);
    };

    measurePinned();
    transcript.addEventListener("scroll", measurePinned, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measurePinned);
    observer?.observe(row);
    observer?.observe(transcript);
    return () => {
      transcript.removeEventListener("scroll", measurePinned);
      observer?.disconnect();
    };
  }, [messageId]);

  const expand = useCallback(() => setIsExpanded(true), []);
  const collapse = useCallback(() => setIsExpanded(false), []);

  return (
    <div
      className={`${bubbleClassName} ${
        isCollapsed ? "cukii-user-bubble--collapsed" : ""
      } ${isExpanded ? "cukii-user-bubble--expanded" : ""}`}
      data-cukii-collapsible={isCollapsible ? "true" : undefined}
      data-testid={`cukii-user-bubble-${messageId}`}
    >
      {/* The body is not a control: only the chevron folds the prompt and only
          the attachment pills open a preview. */}
      <div className="cukii-user-content-shell">
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
