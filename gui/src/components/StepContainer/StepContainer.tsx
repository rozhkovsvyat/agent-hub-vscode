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
  /** This answer is still arriving, so its last line is still moving. */
  isSettling?: boolean;
  latestSummaryIndex?: number;
}

/** An assistant answer beyond this many characters is a longread: it may use
 * the full transcript width instead of the user-capsule lane limit. */
export const ASSISTANT_LONGREAD_CHARS = 800;

export function isAssistantLongRead(renderedText: string): boolean {
  return renderedText.length > ASSISTANT_LONGREAD_CHARS;
}

/** Breathing room between the last word and the reply time riding its line. */
const META_INLINE_GAP = 5;

/** Width the reply time needs at the end of a line, gap included. Measured, not
 * guessed: a 31px constant broke as soon as the clock format changed width. The
 * same rounded value must feed both the decision and the CSS reserve — comparing
 * against an unrounded width while reserving a rounded one lets the spacer wrap
 * on a capsule the measurement called inline, which is the very defect this
 * whole mechanism exists to avoid. */
export function assistantMetaReserve(bubble: HTMLElement): number {
  const time = bubble.querySelector<HTMLElement>(
    ".cukii-assistant-metadata time",
  );
  if (!time) return 0;
  return Math.ceil(time.getBoundingClientRect().width) + META_INLINE_GAP;
}

/**
 * How far right the capsule's content may reach — not where it currently ends.
 *
 * 🔴 The capsule is `width: fit-content`, so a short answer's right edge sits on
 * its last glyph and the space left over is always zero. Measuring against that
 * edge would answer "is there room in the box the text already shrank to",
 * which is never, and the reply time would drop to its own row for every short
 * answer — the commonest case, and exactly where the user capsule keeps it on
 * the line. The question worth asking is whether it fits if the capsule is
 * allowed to grow, so the limit is `max-width`, resolved here because Blink
 * reports a percentage back verbatim.
 */
function bubbleContentRight(
  bubble: HTMLElement,
  style: CSSStyleDeclaration,
): number {
  const rect = bubble.getBoundingClientRect();
  let limit = rect.width;
  const declared = style.maxWidth;
  const parent = bubble.parentElement;
  const view = bubble.ownerDocument.defaultView;
  if (declared && declared !== "none" && parent && view) {
    if (declared.endsWith("%")) {
      const parentStyle = view.getComputedStyle(parent);
      const inner =
        parent.getBoundingClientRect().width -
        parseFloat(parentStyle.paddingLeft || "0") -
        parseFloat(parentStyle.paddingRight || "0");
      const share = (inner * parseFloat(declared)) / 100;
      if (Number.isFinite(share)) limit = Math.max(limit, share);
    } else {
      const px = parseFloat(declared);
      if (Number.isFinite(px)) limit = Math.max(limit, px);
    }
  }
  // `box-sizing: border-box`, so the limit covers padding and border too.
  return (
    rect.left +
    limit -
    parseFloat(style.paddingRight || "0") -
    parseFloat(style.borderRightWidth || "0")
  );
}

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
export function assistantMetaFitsOnLastLine(
  bubble: HTMLElement,
  reserve = assistantMetaReserve(bubble),
): boolean {
  const prose = bubble.querySelector(".cukii-assistant-prose");
  const meta = bubble.querySelector<HTMLElement>(".cukii-assistant-metadata");
  if (!prose || !meta) return false;
  // Anything between the prose and the time — the streaming indicator — means
  // the time is not the tail of the answer at all.
  if (prose.nextElementSibling !== meta) return false;
  const last = prose.lastElementChild;
  // A code block, table, list or heading cannot host the time on its last line.
  if (!last || last.tagName !== "P") return false;
  if (reserve <= 0) return false;

  const doc = bubble.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(last);
  const rects = Array.from(range.getClientRects()).filter(
    (r) => r.width > 0 && r.height > 0,
  );
  if (!rects.length) return false;
  const lastLine = rects[rects.length - 1]!;

  const style = doc.defaultView?.getComputedStyle(bubble);
  if (!style) return false;
  return bubbleContentRight(bubble, style) - lastLine.right >= reserve;
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
  const isLongRead = isAssistantLongRead(proseText);

  const bubbleRef = useRef<HTMLDivElement>(null);
  // Own row is the safe default: it can never collide with the answer's tail,
  // so a capsule that has not been measured yet is merely a little taller.
  const [metaInline, setMetaInline] = useState(false);
  // 🔴 While the answer streams, its tail line grows a token at a time and
  // crosses the fit/no-fit boundary at the end of every visual line. Measuring
  // then would flip the mode — and the capsule's height with it — several times
  // per paragraph, so the transcript would twitch under the reader. The
  // streaming capsule holds the own row and is measured once, when the answer
  // stops moving.
  const settling = props.isSettling === true;
  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!bubble) return;
    if (settling) {
      setMetaInline(false);
      return;
    }
    const apply = () => {
      const reserve = assistantMetaReserve(bubble);
      if (reserve > 0) {
        bubble.style.setProperty("--cukii-meta-reserve", `${reserve}px`);
      }
      setMetaInline(assistantMetaFitsOnLastLine(bubble, reserve));
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(bubble);
    return () => observer.disconnect();
  }, [proseText, isLongRead, settling]);

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
