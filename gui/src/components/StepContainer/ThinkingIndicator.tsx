import { ChatHistoryItem } from "core";
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

  const hasContent = Array.isArray(historyItem.message.content)
    ? !!historyItem.message.content.length
    : !!historyItem.message.content;
  const isThinking =
    isStreaming && !historyItem.isGatheringContext && !hasContent;
  if (!isThinking) {
    return null;
  }

  return (
    <div
      className="text-description px-2 py-2 text-xs"
      data-testid="cukii-thinking-label"
    >
      Thinking...
    </div>
  );
};

export default ThinkingIndicator;
