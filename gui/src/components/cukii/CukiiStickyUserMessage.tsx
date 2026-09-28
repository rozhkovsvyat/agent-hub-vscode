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
 * pixel removes exactly one painted pixel, down to one line, and reversing
 * the wheel restores them one by one. No binary phase, no time-based
 * transition — the capsule cannot pop open or snap shut between frames.
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

interface CukiiStickyUserMessageProps {
  bubbleClassName: string;
  children: ReactNode;
  messageId: string;
  metadata?: ReactNode;
}

/**
 * Long prompts pin at the transcript top, then fold line by line as the
 * reader scrolls past them and unfold symmetrically on reverse. A newer
 * sticky turn displaces the row upward; because the fold is driven by scroll
 * position alone, the displaced capsule keeps exactly the fold it had —
 * closed unless the reader expanded it with the chevron. The chevron's
 * expanded state is user-owned and is never reset by scroll.
 *
 * The row's document-flow height stays at the full measured size for the
 * whole fold; only the painted clip (`--cukii-sticky-visible-height`) and the
 * mask shrink. Flow changes are what triggered scroll anchoring and made the
 * window jerk; scroll handlers here never write `scrollTop`.
 */
export function CukiiStickyUserMessage({
  bubbleClassName,
  children,
  messageId,
  metadata,
}: CukiiStickyUserMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isLongPrompt, setIsLongPrompt] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const isExpandedRef = useRef(isExpanded);
  const naturalContentHeightRef = useRef(0);
  const syncFoldWithScrollRef = useRef<(() => void) | undefined>();
  isExpandedRef.current = isExpanded;

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    naturalContentHeightRef.current = 0;
    const measure = () => {
      naturalContentHeightRef.current = Math.max(
        naturalContentHeightRef.current,
        content.scrollHeight,
      );
      const next =
        naturalContentHeightRef.current >
        CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX;
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
  }, [messageId]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const row = content?.closest<HTMLElement>(".cukii-user-row--sticky");
    const transcript = content?.closest<HTMLElement>(".cukii-transcript");
    const bubble = content?.closest<HTMLElement>(".cukii-user-message-bubble");
    if (!content || !row || !transcript || !bubble) return;

    let stableFlowHeight = 0;
    // Scroll position of the row's flow top. While the row moves with the
    // document it equals scrollTop + rowTop; once pinned, the captured value
    // freezes so progress measures the scroll consumed since the pin. Blink's
    // painted sticky offset tracks live scrollTop, so re-deriving the origin
    // from the pinned row would lock progress at zero.
    let stickyStart: number | null = null;
    // Collapsing the inner ProseMirror to one row also makes Chromium report a
    // smaller `content.scrollHeight` on the next scroll/ResizeObserver tick.
    // That painted measurement is not the prompt's natural height: keep the
    // largest uncollapsed measurement for the lifetime of this message so the
    // fold cannot immediately clear itself after reaching one row.
    naturalContentHeightRef.current = Math.max(
      naturalContentHeightRef.current,
      content.scrollHeight,
    );

    const clearFold = () => {
      delete content.dataset.cukiiScrollFolding;
      content.style.removeProperty("--cukii-sticky-visible-height");
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
      row.style.removeProperty("--cukii-sticky-flow-height");
      row.style.removeProperty("--cukii-sticky-mask-height");
      row.removeAttribute("data-cukii-collapse-progress");
    };

    const syncFoldWithScroll = () => {
      naturalContentHeightRef.current = Math.max(
        naturalContentHeightRef.current,
        content.scrollHeight,
      );
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

      if (!isStickyRowPinned({ rowTopFromScrollport, scrollTop })) {
        // Plain flow: the capsule paints at its natural height and the next
        // pin inherits an exact fold origin. The user's expanded/collapsed
        // choice is untouched — unpinning never flips it.
        stickyStart = scrollTop + Math.max(0, rowTopFromScrollport);
        clearFold();
        return;
      }
      if (stickyStart === null) {
        stickyStart = scrollTop + Math.max(0, rowTopFromScrollport);
      }

      const geometry = resolveStickyCollapseGeometry({
        fullHeight,
        consumedScroll: scrollTop - stickyStart,
      });
      const paintedVisibleHeight = isExpandedRef.current
        ? fullHeight
        : geometry.visibleHeight;

      const contentHeight = content.getBoundingClientRect().height;
      const bubbleOverhead = Math.max(
        0,
        bubble.getBoundingClientRect().height - contentHeight,
      );
      const rowStyle = getComputedStyle(row);
      const rowPaddingTop = Number.parseFloat(rowStyle.paddingTop) || 0;
      const rowPaddingBottom = Number.parseFloat(rowStyle.paddingBottom) || 0;
      const measuredFlowHeight =
        rowPaddingTop + rowPaddingBottom + bubbleOverhead + fullHeight;
      // Receipt layout can still change when the inline-fit observer runs.
      // The flow box never shrinks during the fold: keeping it at the full
      // measurement is what makes the painted fold pixel-synchronous without
      // triggering scroll anchoring.
      stableFlowHeight = Math.max(stableFlowHeight, measuredFlowHeight);
      const paintedRowHeight =
        rowPaddingTop +
        rowPaddingBottom +
        bubbleOverhead +
        paintedVisibleHeight;
      row.style.setProperty(
        "--cukii-sticky-flow-height",
        `${Math.ceil(stableFlowHeight)}px`,
      );
      row.style.setProperty(
        "--cukii-sticky-mask-height",
        `${Math.ceil(paintedRowHeight)}px`,
      );
      row.setAttribute(
        "data-cukii-collapse-progress",
        geometry.progress.toFixed(4),
      );

      const folded = !isExpandedRef.current && geometry.progress > 0;
      const fullyCollapsed = !isExpandedRef.current && geometry.progress >= 1;
      if (folded) {
        content.dataset.cukiiScrollFolding = "true";
        content.style.setProperty(
          "--cukii-sticky-visible-height",
          `${geometry.visibleHeight}px`,
        );
      } else {
        delete content.dataset.cukiiScrollFolding;
        content.style.removeProperty("--cukii-sticky-visible-height");
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

  const expand = useCallback(() => setIsExpanded(true), []);
  const collapse = useCallback(() => setIsExpanded(false), []);

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
          {children}
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
