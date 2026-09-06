import { ChatHistoryItem } from "core";
import { renderChatMessage, stripImages } from "core/util/messageContent";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { useAppSelector } from "../../redux/hooks";
import { selectUIConfig } from "../../redux/slices/configSlice";
import { formatMessageTime } from "../../util/formatMessageTime";
import ThinkingBlockPeek from "../mainInput/belowMainInput/ThinkingBlockPeek";
import StyledMarkdownPreview from "../StyledMarkdownPreview";
import ConversationSummary from "./ConversationSummary";
import ThinkingIndicator from "./ThinkingIndicator";

interface StepContainerProps {
  item: ChatHistoryItem & { createdAt?: number };
  index: number;
  isLast: boolean;
  latestSummaryIndex?: number;
}

/** An assistant answer beyond this many characters is a longread: it may use
 * the full transcript width instead of the user-capsule lane limit. */
export const ASSISTANT_LONGREAD_CHARS = 800;

/** Breathing room between the last word and the reply time riding its line. */
const META_INLINE_GAP = 5;

/**
 * Does the reply time still fit at the end of the answer's last line?
 *
 * MAX puts the time on the last text line when it fits and drops it to a
 * compact row of its own when it does not. CSS cannot make that choice: the
 * only pure-CSS way to reserve the slot is an inline `::after` spacer, and when
 * that spacer wraps it opens a full 19.5px line box — the paragraph's strut is
 * the floor, so the "compact own row" the reference calls for is unreachable
 * that way. It also cannot tell a paragraph tail from a code block or a table,
 * where an absolutely placed time would land on the last glyphs.
 *
 * So the mode is measured. The answer is read off the real glyph rectangles,
 * which is stable under re-measurement: the spacer is a pseudo-element and
 * therefore never part of the text rects this looks at, so turning inline mode
 * on cannot flip the next measurement back off.
 */
export function assistantMetaFitsOnLastLine(bubble: HTMLElement): boolean {
  const prose = bubble.querySelector(".cukii-assistant-prose");
  const meta = bubble.querySelector<HTMLElement>(".cukii-assistant-metadata");
  if (!prose || !meta) return false;
  // Anything between the prose and the time — the streaming indicator — means
  // the time is not the tail of the answer at all.
  if (prose.nextElementSibling !== meta) return false;
  const last = prose.lastElementChild;
  // A code block, table, list or heading cannot host the time on its last line.
  if (!last || last.tagName !== "P") return false;

  const doc = bubble.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(last);
  const rects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  if (!rects.length) return false;
  const lastLine = rects[rects.length - 1]!;

  const time = meta.querySelector("time") ?? meta;
  const needed = time.getBoundingClientRect().width + META_INLINE_GAP;
  if (needed <= 0) return false;

  const style = doc.defaultView?.getComputedStyle(bubble);
  const contentRight =
    bubble.getBoundingClientRect().right -
    parseFloat(style?.paddingRight || "0") -
    parseFloat(style?.borderRightWidth || "0");
  return contentRight - lastLine.right >= needed;
}

function StepContainer(props: StepContainerProps) {
  const uiConfig = useAppSelector(selectUIConfig);

  // Calculate dimming and indicator state based on latest summary index
  const latestSummaryIndex = props.latestSummaryIndex ?? -1;
  const isBeforeLatestSummary =
    latestSummaryIndex !== -1 && props.index <= latestSummaryIndex;
  const isLatestSummary =
    latestSummaryIndex !== -1 && props.index === latestSummaryIndex;
  const proseText = renderChatMessage(props.item.message);
  const isLongRead = proseText.length > ASSISTANT_LONGREAD_CHARS;

  const bubbleRef = useRef<HTMLDivElement>(null);
  // Own row is the safe default: it can never collide with the answer's tail,
  // so a capsule that has not been measured yet is merely a little taller.
  const [metaInline, setMetaInline] = useState(false);
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    const apply = () => {
      // The reserve is measured, not guessed: a 31px constant broke as soon as
      // the clock format changed width.
      const time = bubble.querySelector<HTMLElement>(
        ".cukii-assistant-metadata time",
      );
      if (time) {
        bubble.style.setProperty(
          "--cukii-meta-reserve",
          `${Math.ceil(time.getBoundingClientRect().width) + META_INLINE_GAP}px`,
        );
      }
      setMetaInline(assistantMetaFitsOnLastLine(bubble));
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(bubble);
    return () => observer.disconnect();
  }, [proseText, isLongRead]);

  return (
    <div>
      <div
        ref={bubbleRef}
        className={`cukii-assistant-bubble bg-background ${
          isLongRead ? "cukii-assistant-bubble--longread" : ""
        } ${metaInline ? "cukii-assistant-bubble--meta-inline" : ""} ${
          isBeforeLatestSummary ? "opacity-35" : ""
        }`}
      >
        {uiConfig?.displayRawMarkdown ? (
          <pre className="text-2xs max-w-full overflow-x-auto whitespace-pre-wrap break-words p-4">
            {proseText}
          </pre>
        ) : (
          <>
            {props.item.reasoning?.text?.trim() && (
              <ThinkingBlockPeek
                content={props.item.reasoning.text}
                index={props.index}
                prevItem={props.index > 0 ? props.item : null}
                inProgress={!props.item.reasoning?.endAt}
              />
            )}

            {/* The markdown wrapper ships an 8px side padding of its own, so
                the answer started 8px further in than the user's prose does in
                its capsule. The capsule owns the whole gutter; this class is
                the stable handle for zeroing that inner wall (the styled
                component's own class is a build hash) and the anchor the
                reply-time spacer keys off. */}
            <StyledMarkdownPreview
              className="cukii-assistant-prose"
              isRenderingInStepContainer
              useParentBackgroundColor
              source={stripImages(props.item.message.content)}
              itemIndex={props.index}
            />
          </>
        )}
        {props.isLast && !props.item.reasoning?.text?.trim() && (
          <ThinkingIndicator historyItem={props.item} />
        )}
        {formatMessageTime(props.item.createdAt) !== undefined && (
          <span className="cukii-assistant-metadata">
            <time>{formatMessageTime(props.item.createdAt)}</time>
          </span>
        )}
      </div>

      {/* Show compaction indicator for the latest summary */}
      {isLatestSummary && (
        <div className="mx-1.5 my-5">
          <div className="flex items-center">
            <div className="border-border flex-1 border-t border-solid"></div>
            <span className="text-description mx-3 text-xs">
              Previous Conversation Compacted
            </span>
            <div className="border-border flex-1 border-t border-solid"></div>
          </div>
        </div>
      )}

      {/* ConversationSummary is outside the dimmed container so it's always at full opacity */}
      <ConversationSummary item={props.item} index={props.index} />
    </div>
  );
}

// Chat can reconcile for unrelated controls (for example a bridge receipt) while
// a large restored transcript is visible. The history item and its position are
// immutable between transcript changes, so avoid re-running markdown rendering
// for every visible assistant row in that case.
export default memo(StepContainer);
