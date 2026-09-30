import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX = 20;
/** A row counts as pinned while its painted top sits on the scrollport edge.
 * Rows displaced upward by a newer sticky turn report a negative top and
 * remain pinned for fold purposes: they must leave the window folded. */
export const STICKY_PIN_EDGE_PX = 1;

export function isStickyRowPinned({
  rowTopFromScrollport,
  scrollTop,
}: {
  rowTopFromScrollport: number;
  scrollTop: number;
}): boolean {
  return rowTopFromScrollport <= STICKY_PIN_EDGE_PX && scrollTop > 0;
}

/**
 * The fold is a pure function of how far the transcript scrolled past the
 * point where the row first touched the sticky edge: every consumed scroll
 * pixel removes exactly one painted pixel, down to one line. Before that
 * terminal state, reversing the wheel restores the same pixels. Once the row
 * reaches one line, that terminal state stays latched even if sticky geometry
 * briefly crosses the natural pin edge; only the chevron opens it again.
 */
export function resolveStickyCollapseGeometry({
  fullHeight,
  consumedScroll,
}: {
  fullHeight: number;
  consumedScroll: number;
}): {
  progress: number;
  visibleHeight: number;
} {
  const naturalHeight = Math.max(
    CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX,
    fullHeight,
  );
  const collapseDistance =
    naturalHeight - CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX;
  if (collapseDistance <= 0) {
    return { progress: 0, visibleHeight: naturalHeight };
  }
  const progress = Math.min(1, Math.max(0, consumedScroll / collapseDistance));
  return {
    progress,
    visibleHeight: naturalHeight - progress * collapseDistance,
  };
}

export function resolveStickyNaturalHeight({
  measuredHeight,
  previousHeight,
  terminallyCollapsed,
}: {
  measuredHeight: number;
  previousHeight: number;
  terminallyCollapsed: boolean;
}): number {
  // At the terminal one-line state CSS also shrinks the ProseMirror itself,
  // so its 20px scrollHeight is no longer a natural measurement. Preserve the
  // last expanded value for that single state. Everywhere else the current
  // measurement is authoritative: keeping the historical maximum makes a
  // capsule remember an older, narrower layout and jump on the final reverse
  // scroll pixel after the sidebar or window becomes wider.
  return terminallyCollapsed
    ? Math.max(CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX, previousHeight)
    : Math.max(CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX, measuredHeight);
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
 * Long prompts pin at the transcript top, then fold line by line as the
 * reader scrolls past them. Once a capsule reaches one row, that closed state
 * latches for the lifetime of that rendered turn; reverse scrolling cannot
 * make it oscillate. A newer sticky turn displaces the old row upward one-line
 * closed unless the reader explicitly expanded it. The chevron owns the
 * persistent closed or expanded choice.
 *
 * The row's flow box follows the painted clip. The transcript disables native
 * scroll anchoring, so shrinking the row cannot make Chromium compensate the
 * scroll position; no invisible full-prompt spacer remains between the sticky
 * capsule and its answer. Scroll handlers here never write `scrollTop`.
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
  const isExpandedRef = useRef(isExpanded);
  const isCollapsedLatchedRef = useRef(false);
  const naturalContentHeightRef = useRef(0);
  const naturalBodyHeightRef = useRef(0);
  const syncFoldWithScrollRef = useRef<(() => void) | undefined>();
  isExpandedRef.current = isExpanded;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    isCollapsedLatchedRef.current = false;
    setIsExpanded(false);
    naturalContentHeightRef.current = 0;
    naturalBodyHeightRef.current = 0;
    const measure = () => {
      const measuredContentHeight = content.scrollHeight;
      const terminallyCollapsed = content.classList.contains(
        "cukii-user-message-content--collapsed",
      );
      naturalContentHeightRef.current = resolveStickyNaturalHeight({
        measuredHeight: measuredContentHeight,
        previousHeight: naturalContentHeightRef.current,
        terminallyCollapsed,
      });
      const body = messageBodyRef.current;
      const measuredBodyHeight = body
        ? Math.max(
            body.scrollHeight,
            Math.ceil(body.getBoundingClientRect().height),
          )
        : 0;
      if (measuredBodyHeight > 0) {
        naturalBodyHeightRef.current = resolveStickyNaturalHeight({
          measuredHeight: measuredBodyHeight,
          previousHeight: naturalBodyHeightRef.current,
          terminallyCollapsed,
        });
      }
      // An embedded MAX reaction belongs to the painted message, but it is
      // not prompt text and must not turn a one-line message into a foldable
      // sticky capsule. At the terminal fold CSS also makes the body report
      // 20px; preserve its last natural measurement just as we do for the
      // outer content or ResizeObserver will alternate long -> short -> long
      // and flash the full prompt. In layout-less tests the body measures
      // zero, so keep the historical outer-height fallback used by fixtures.
      const promptBodyHeight =
        measuredBodyHeight > 0
          ? naturalBodyHeightRef.current
          : measuredContentHeight;
      // Media-only messages have no meaningful terminal text row. Folding
      // one used to hide the thumbnail strip and leave an empty orange
      // capsule containing only a chevron/receipt. Keep that compact media
      // card intact; text+media messages still fold to their text line.
      const next =
        foldableText &&
        promptBodyHeight > CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX;
      setIsLongPrompt(next);
      if (!next) setIsExpanded(false);
    };

    measure();
    // Markdown/editor descendants can finish their first layout after the
    // parent layout effect. ResizeObserver is not required to emit a second
    // record when the element is already at its final size by observation
    // time, so an initial zero would otherwise classify every real long
    // capsule as short forever. Re-measure once after the first paint.
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
    resizeObserver?.observe(content);
    if (content.firstElementChild) {
      resizeObserver?.observe(content.firstElementChild);
    }
    content.addEventListener("load", measure, true);

    return () => {
      cancelAnimationFrame(postPaintMeasurement);
      mutationObserver?.disconnect();
      content.removeEventListener("load", measure, true);
      resizeObserver?.disconnect();
    };
  }, [foldableText, messageId]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const row = content?.closest<HTMLElement>(".cukii-user-row--sticky");
    const transcript = content?.closest<HTMLElement>(".cukii-transcript");
    const bubble = content?.closest<HTMLElement>(".cukii-user-message-bubble");
    const messageFrame = bubble?.closest<HTMLElement>(".cukii-user-message");
    if (!content || !row || !transcript || !bubble) return;
    isCollapsedLatchedRef.current = false;
    // Scroll position at the first pinned frame. It then freezes so progress
    // measures only scroll consumed after the pin. Blink's painted sticky
    // offset tracks live scrollTop, so re-deriving the origin from the pinned
    // row would lock progress at zero.
    let stickyStart: number | null = null;
    // Collapsing the inner ProseMirror to one row also makes Chromium report a
    // smaller `content.scrollHeight` on the next scroll/ResizeObserver tick.
    // That painted measurement is not the prompt's natural height: keep the
    // largest uncollapsed measurement for the lifetime of this message so the
    // fold cannot immediately clear itself after reaching one row.
    naturalContentHeightRef.current = resolveStickyNaturalHeight({
      measuredHeight: content.scrollHeight,
      previousHeight: naturalContentHeightRef.current,
      terminallyCollapsed: content.classList.contains(
        "cukii-user-message-content--collapsed",
      ),
    });

    const clearFold = () => {
      delete content.dataset.cukiiScrollFolding;
      content.style.removeProperty("--cukii-sticky-visible-height");
      content.parentElement?.style.removeProperty(
        "--cukii-sticky-visible-height",
      );
      content.classList.remove("cukii-user-message-content--collapsed");
      bubble.removeAttribute("data-cukii-collapsible");
      bubble.classList.remove("cukii-user-bubble--collapsed");
      const toggle = bubble.querySelector<HTMLButtonElement>(
        ".cukii-user-fold-toggle",
      );
      if (toggle) {
        toggle.disabled = true;
        toggle.tabIndex = -1;
        toggle.style.visibility = "hidden";
        toggle.setAttribute("aria-hidden", "true");
        toggle.removeAttribute("aria-label");
      }
      row.style.removeProperty("--cukii-sticky-mask-height");
      row.removeAttribute("data-cukii-collapse-progress");
    };

    const syncFoldWithScroll = () => {
      naturalContentHeightRef.current = resolveStickyNaturalHeight({
        measuredHeight: content.scrollHeight,
        previousHeight: naturalContentHeightRef.current,
        terminallyCollapsed: content.classList.contains(
          "cukii-user-message-content--collapsed",
        ),
      });
      const fullHeight = naturalContentHeightRef.current;
      if (
        !isLongPrompt ||
        fullHeight <= CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX
      ) {
        stickyStart = null;
        clearFold();
        return;
      }

      const transcriptRect = transcript.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const rowTopFromScrollport = rowRect.top - transcriptRect.top;
      const scrollTop = transcript.scrollTop;

      const rowIsPinned = isStickyRowPinned({
        rowTopFromScrollport,
        scrollTop,
      });
      if (!rowIsPinned) {
        // Plain flow: the capsule paints at its natural height. Capture the
        // fold origin only on the first pinned frame below; otherwise a
        // fractional flow top can consume a sub-pixel at contact and violate
        // the distinct full-height pin frame promised by the interaction. A
        // terminally closed capsule is the exception: clearing that state at
        // the pin edge made the recorded UI alternate between a full-screen
        // prompt and one row as sticky/ResizeObserver geometry fed back into
        // itself. Keep the closed paint until the chevron explicitly opens it.
        stickyStart = null;
        if (!isCollapsedLatchedRef.current || isExpandedRef.current) {
          clearFold();
          return;
        }
      }
      if (rowIsPinned && stickyStart === null) {
        stickyStart = scrollTop;
      }

      const geometry = rowIsPinned
        ? resolveStickyCollapseGeometry({
            fullHeight,
            consumedScroll: scrollTop - (stickyStart ?? scrollTop),
          })
        : {
            progress: 1,
            visibleHeight: CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX,
          };
      const displacedByNewerSticky = rowTopFromScrollport < -STICKY_PIN_EDGE_PX;
      if (
        geometry.progress >= 1 ||
        (displacedByNewerSticky && !isExpandedRef.current)
      ) {
        isCollapsedLatchedRef.current = true;
      }
      const collapseProgress = isCollapsedLatchedRef.current
        ? 1
        : geometry.progress;
      const paintedVisibleHeight = isExpandedRef.current
        ? fullHeight
        : isCollapsedLatchedRef.current
          ? CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX
          : geometry.visibleHeight;

      const contentHeight = content.getBoundingClientRect().height;
      const frameHeight = Math.max(
        bubble.getBoundingClientRect().height,
        messageFrame?.getBoundingClientRect().height ?? 0,
      );
      // Text reactions are part of contentHeight and fold together with the
      // prompt. The only reaction outside this frame is the media-only sibling,
      // so it cannot inflate sticky geometry or leave an invisible spacer.
      const bubbleOverhead = Math.max(0, frameHeight - contentHeight);
      const rowStyle = getComputedStyle(row);
      const rowPaddingTop = Number.parseFloat(rowStyle.paddingTop) || 0;
      const rowPaddingBottom = Number.parseFloat(rowStyle.paddingBottom) || 0;
      const paintedRowHeight =
        rowPaddingTop +
        rowPaddingBottom +
        bubbleOverhead +
        paintedVisibleHeight;
      row.style.setProperty(
        "--cukii-sticky-mask-height",
        `${Math.ceil(paintedRowHeight)}px`,
      );
      row.setAttribute(
        "data-cukii-collapse-progress",
        collapseProgress.toFixed(4),
      );

      const folded = !isExpandedRef.current && collapseProgress > 0;
      const fullyCollapsed = !isExpandedRef.current && collapseProgress >= 1;
      if (folded) {
        content.dataset.cukiiScrollFolding = "true";
        content.style.setProperty(
          "--cukii-sticky-visible-height",
          `${paintedVisibleHeight}px`,
        );
        // The truncation gradient is a sibling of the clipped content inside
        // the shell; custom properties do not cross that boundary, so the
        // fade reads the remaining painted height from the shell (M2).
        content.parentElement?.style.setProperty(
          "--cukii-sticky-visible-height",
          `${paintedVisibleHeight}px`,
        );
      } else {
        delete content.dataset.cukiiScrollFolding;
        content.style.removeProperty("--cukii-sticky-visible-height");
        content.parentElement?.style.removeProperty(
          "--cukii-sticky-visible-height",
        );
      }

      const isCollapsible = folded || isExpandedRef.current;
      if (isCollapsible) {
        if (bubble.dataset.cukiiCollapsible !== "true") {
          bubble.setAttribute("data-cukii-collapsible", "true");
        }
      } else if (bubble.hasAttribute("data-cukii-collapsible")) {
        bubble.removeAttribute("data-cukii-collapsible");
      }
      bubble.classList.toggle("cukii-user-bubble--collapsed", fullyCollapsed);
      content.classList.toggle(
        "cukii-user-message-content--collapsed",
        fullyCollapsed,
      );
      const toggle = bubble.querySelector<HTMLButtonElement>(
        ".cukii-user-fold-toggle",
      );
      if (toggle) {
        toggle.disabled = !isCollapsible;
        toggle.tabIndex = isCollapsible ? 0 : -1;
        toggle.style.visibility = isCollapsible ? "visible" : "hidden";
        toggle.toggleAttribute("aria-hidden", !isCollapsible);
        if (isCollapsible) {
          toggle.setAttribute(
            "aria-label",
            isExpandedRef.current ? "Show less" : "Show more",
          );
        } else {
          toggle.removeAttribute("aria-label");
        }
      }
    };

    syncFoldWithScrollRef.current = syncFoldWithScroll;
    syncFoldWithScroll();
    transcript.addEventListener("scroll", syncFoldWithScroll, {
      passive: true,
    });
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(syncFoldWithScroll);
    observer?.observe(transcript);
    if (content.firstElementChild) {
      observer?.observe(content.firstElementChild);
    }
    return () => {
      syncFoldWithScrollRef.current = undefined;
      transcript.removeEventListener("scroll", syncFoldWithScroll);
      observer?.disconnect();
      clearFold();
    };
  }, [isLongPrompt, messageId]);

  useLayoutEffect(() => {
    syncFoldWithScrollRef.current?.();
  }, [isExpanded]);

  // React rewrites the bubble's className whenever the transcript adds a
  // modifier (for example an agent reaction), which silently dropped the
  // imperatively latched --collapsed class and let the truncation gradient
  // repaint over the single terminal row until the next scroll (Fable review).
  useLayoutEffect(() => {
    const bubble = contentRef.current?.closest<HTMLElement>(
      ".cukii-user-message-bubble",
    );
    if (!bubble) return;
    bubble.classList.toggle(
      "cukii-user-bubble--collapsed",
      isCollapsedLatchedRef.current && !isExpandedRef.current,
    );
  });

  const expand = useCallback(() => setIsExpanded(true), []);
  const collapse = useCallback(() => {
    // The chevron is an explicit close command, not a request to return to an
    // incidental mid-scroll height. The closed state remains latched until the
    // chevron opens it again or this rendered message is replaced.
    isCollapsedLatchedRef.current = true;
    setIsExpanded(false);
  }, []);

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
          <button
            aria-expanded={isExpanded}
            aria-hidden="true"
            className="cukii-user-fold-toggle"
            onClick={(event) => {
              event.stopPropagation();
              if (isExpanded) collapse();
              else expand();
            }}
            style={{ visibility: "hidden" }}
            tabIndex={-1}
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
