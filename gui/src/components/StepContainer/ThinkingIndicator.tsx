import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/outline";
import { ChatHistoryItem } from "core";
import { useState } from "react";
import { useAppSelector } from "../../redux/hooks";

interface ThinkingIndicatorProps {
  historyItem: ChatHistoryItem;
}

/**
 * Надпись, что модель думает. Это не лоадер: живой лоадер — отдельная
 * нижняя строка стрима. Раньше оба ряда рисовали один и тот же глиф,
 * и в ленте появлялся дубль.
 */
const ThinkingIndicator = ({ historyItem }: ThinkingIndicatorProps) => {
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const [open, setOpen] = useState(false);

  const hasContent = Array.isArray(historyItem.message.content)
    ? !!historyItem.message.content.length
    : !!historyItem.message.content;
  const isThinking =
    isStreaming && !historyItem.isGatheringContext && !hasContent;
  if (!isThinking) {
    return null;
  }

  return (
    <div className="px-2 py-2 text-xs">
      <button
        type="button"
        className="cukii-thinking-summary cukii-thinking-summary-active flex min-w-0 items-center gap-1.5 rounded-full px-2"
        data-testid="cukii-thinking-label"
        aria-expanded={open}
        aria-controls="cukii-thinking-indicator-details"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="cukii-thinking-status-dot" aria-hidden="true" />
        <span>Thinking</span>
        {open ? (
          <ChevronUpIcon className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronDownIcon className="h-3 w-3" aria-hidden="true" />
        )}
      </button>
      {open && (
        <div
          id="cukii-thinking-indicator-details"
          className="text-description-muted pl-2 pt-1"
        >
          Thinking in progress
        </div>
      )}
    </div>
  );
};

export default ThinkingIndicator;
