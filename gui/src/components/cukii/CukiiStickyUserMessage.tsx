import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export const CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX = 20;

type StickyCollapsePhase = "flow" | "collapsed";

interface StickyCollapseGeometryArgs {
  fullHeight: number;
  hasReachedStickyEdge: boolean;
}

export function resolveStickyCollapseGeometry({
  fullHeight,
  hasReachedStickyEdge,
}: StickyCollapseGeometryArgs): {
  phase: StickyCollapsePhase;
  progress: number;
  visibleHeight: number;
} {
  const naturalHeight = Math.max(
    CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX,
    fullHeight,
  );
  const collapseDistance =
    naturalHeight - CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX;
  if (!hasReachedStickyEdge || collapseDistance <= 0) {
    return { phase: "flow", progress: 0, visibleHeight: naturalHeight };
  }
  return {
    phase: "collapsed",
    progress: 1,
    visibleHeight: CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX,
  };
}

interface CukiiStickyUserMessageProps {
  bubbleClassName: string;
  children: ReactNode;
  messageId: string;
  metadata?: ReactNode;
}

/**
 * Long prompts fold to one line as soon as their row reaches the transcript
 * top and remain folded while a newer sticky turn displaces them upward.
 * Cukii keeps the fold toggle and delivery metadata in one compact MAX-style
 * footer so neither state creates a second toolbar row.
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
      const transcriptRect = transcript.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const rowTopFromScrollport = rowRect.top - transcriptRect.top;

      const fullHeight = naturalContentHeightRef.current;
      if (
        !isLongPrompt ||
        fullHeight <= CLAUDE_USER_MESSAGE_COLLAPSED_HEIGHT_PX
      ) {
        clearFold();
        return;
      }

      // Collapse as soon as the row reaches the sticky edge. A previous row
      // pushed above it by the next sticky prompt stays collapsed while it
      // leaves the viewport instead of expanding into a large orange block.
      const hasReachedStickyEdge =
        transcript.scrollTop > 0 && rowTopFromScrollport <= 1;
      const geometry = resolveStickyCollapseGeometry({
        fullHeight,
        hasReachedStickyEdge,
      });
      const visibleHeight =
        isExpandedRef.current || geometry.phase === "flow"
          ? fullHeight
          : geometry.visibleHeight;

      // The scrollport's layout height stays equal to the fully expanded row.
      // Only the painted/clipped bubble changes height, so Chromium never has
      // to compensate scrollTop while the sticky header folds.
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
      // Never let that state edge shrink the document-flow box: a changing
      // scrollHeight is exactly what made the wheel feel stuck.
      stableFlowHeight = Math.max(stableFlowHeight, measuredFlowHeight);
      const paintedRowHeight =
        rowPaddingTop + rowPaddingBottom + bubbleOverhead + visibleHeight;
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

      if (geometry.phase !== "flow" && !isExpandedRef.current) {
        content.dataset.cukiiScrollFolding = "true";
        content.style.setProperty(
          "--cukii-sticky-visible-height",
          `${geometry.visibleHeight}px`,
        );
      } else {
        delete content.dataset.cukiiScrollFolding;
        content.style.removeProperty("--cukii-sticky-visible-height");
      }

      const isCollapsible = geometry.phase !== "flow";
      if (isCollapsible) {
        if (bubble.dataset.cukiiCollapsible !== "true") {
          bubble.setAttribute("data-cukii-collapsible", "true");
        }
      } else if (bubble.hasAttribute("data-cukii-collapsible")) {
        bubble.removeAttribute("data-cukii-collapsible");
      }
      bubble.classList.toggle(
        "cukii-user-bubble--collapsed",
        geometry.phase === "collapsed" && !isExpandedRef.current,
      );
      content.classList.toggle(
        "cukii-user-message-content--collapsed",
        geometry.phase === "collapsed" && !isExpandedRef.current,
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
      if (geometry.phase === "flow" && isExpandedRef.current) {
        isExpandedRef.current = false;
        setIsExpanded(false);
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
