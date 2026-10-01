import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX = 20;
/** Bubble inset around the single terminal text row: 8px top + 10px bottom. */
export const STICKY_BUBBLE_TERMINAL_HEIGHT_PX = 38;

/**
 * Slack reserved below a turn so the sticky row is evicted by the next turn
 * only once the next capsule reaches the one-line painted row, not the full
 * (unclipped) flow box. The turn pulls the following content back up by the
 * same amount, so the slack is invisible in normal flow.
 */
export function resolveStickyTurnSlack({
  rowHeight,
  rowPaddingTop,
  rowPaddingBottom,
  longPrompt,
  expanded,
}: {
  rowHeight: number;
  rowPaddingTop: number;
  rowPaddingBottom: number;
  longPrompt: boolean;
  expanded: boolean;
}): number {
  if (!longPrompt || expanded) return 0;
  return Math.max(
    0,
    Math.ceil(
      rowHeight -
        rowPaddingTop -
        rowPaddingBottom -
        STICKY_BUBBLE_TERMINAL_HEIGHT_PX,
    ),
  );
}

interface CukiiStickyUserMessageProps {
  bubbleClassName: string;
  children: ReactNode;
  foldableText?: boolean;
  messageId: string;
  metadata?: ReactNode;
  reaction?: ReactNode;
}

/**
 * Long prompts pin at the transcript top and fold line by line as the reader
 * scrolls past them, down to one text row, then ride out of view when the
 * next turn arrives.
 *
 * The fold itself is not computed here. It is a CSS scroll-driven animation
 * (`--cukii-fold-px`, see `.cukii-user-row--sticky` in index.css) bound to the
 * turn's 1px sentinel: every scrolled pixel past the pin removes exactly one
 * painted pixel through `clip-path`, which never changes layout. Because no
 * JavaScript state depends on scroll position, there is nothing that can
 * oscillate when streamed content, auto-scroll or scroll clamping move the
 * transcript underneath the capsule (owner videos 29.09 / 01.10).
 *
 * This component owns only the layout-stable facts CSS cannot derive: whether
 * the prompt is long enough to fold, the slack the turn must reserve for a
 * one-line eviction, and the chevron's explicit expanded state.
 */
export function CukiiStickyUserMessage({
  bubbleClassName,
  children,
  foldableText = true,
  messageId,
  metadata,
  reaction,
}: CukiiStickyUserMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const messageBodyRef = useRef<HTMLDivElement>(null);
  const [isLongPrompt, setIsLongPrompt] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  // Natural geometry only. The clip-path fold does not affect any box here,
  // so these measurements cannot feed back into themselves.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const body = messageBodyRef.current;
    if (!content || !body) return;
    setIsExpanded(false);

    const measure = () => {
      const bodyHeight = Math.max(
        body.scrollHeight,
        Math.ceil(body.getBoundingClientRect().height),
      );
      // An embedded MAX reaction belongs to the painted message, but it is
      // not prompt text and must not turn a one-line message into a foldable
      // capsule; media-only messages have no text row to fold to.
      setIsLongPrompt(
        foldableText && bodyHeight > CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX,
      );
    };

    measure();
    // Markdown/editor descendants can finish their first layout after the
    // parent layout effect; re-measure once after the first paint.
    const postPaintMeasurement = requestAnimationFrame(measure);
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(measure);
    mutationObserver?.observe(content, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    resizeObserver?.observe(body);
    content.addEventListener("load", measure, true);
    return () => {
      cancelAnimationFrame(postPaintMeasurement);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      content.removeEventListener("load", measure, true);
    };
  }, [foldableText, messageId]);

  // Row/turn bookkeeping: the row carries the expanded modifier (which turns
  // the fold animation off) and the turn carries the eviction slack.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const row = content?.closest<HTMLElement>(".cukii-user-row--sticky");
    const turn = row?.closest<HTMLElement>(".cukii-turn");
    if (!content || !row) return;
    row.classList.toggle("cukii-user-row--expanded", isExpanded);
    if (!turn) return;

    const applySlack = () => {
      const rowStyle = getComputedStyle(row);
      const slack = resolveStickyTurnSlack({
        rowHeight: row.getBoundingClientRect().height,
        rowPaddingTop: Number.parseFloat(rowStyle.paddingTop) || 0,
        rowPaddingBottom: Number.parseFloat(rowStyle.paddingBottom) || 0,
        longPrompt: isLongPrompt,
        expanded: isExpanded,
      });
      if (slack > 0) {
        turn.style.setProperty("--cukii-turn-slack", `${slack}px`);
      } else {
        turn.style.removeProperty("--cukii-turn-slack");
      }
    };
    applySlack();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(applySlack);
    resizeObserver?.observe(row);
    return () => {
      resizeObserver?.disconnect();
      row.classList.remove("cukii-user-row--expanded");
      turn.style.removeProperty("--cukii-turn-slack");
    };
  }, [isExpanded, isLongPrompt, messageId]);

  const toggle = useCallback(() => setIsExpanded((value) => !value), []);

  return (
    <div
      className={`${bubbleClassName} ${
        isExpanded ? "cukii-user-bubble--expanded" : ""
      }`}
      data-cukii-long-prompt={isLongPrompt ? "true" : undefined}
      data-testid={`cukii-user-bubble-${messageId}`}
    >
      {/* The body is not a control: only the chevron folds the prompt and only
          the attachment pills open a preview. */}
      <div className="cukii-user-content-shell">
        <div className="cukii-user-message-content" ref={contentRef}>
          <div className="cukii-user-message-body" ref={messageBodyRef}>
            {children}
          </div>
          {reaction}
        </div>
        {isLongPrompt && (
          <div aria-hidden="true" className="cukii-user-truncation-gradient" />
        )}
      </div>
      {isLongPrompt ? (
        <div className="cukii-user-fold-footer">
          {/* Visibility is CSS-driven: the chevron appears once the row has
              folded by at least one pixel or while explicitly expanded. */}
          <button
            aria-expanded={isExpanded}
            aria-label={isExpanded ? "Show less" : "Show more"}
            className="cukii-user-fold-toggle"
            onClick={(event) => {
              event.stopPropagation();
              toggle();
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
