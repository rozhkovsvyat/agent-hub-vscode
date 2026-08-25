import { ChatHistoryItem } from "core";
import { useAppSelector } from "../../redux/hooks";
import { useThinkingPhrase } from "../cukii/useThinkingPhrase";
import { CukiiThinkingGlyph } from "../cukii/CukiiThinkingGlyph";

interface ThinkingIndicatorProps {
  historyItem: ChatHistoryItem;
}
/*
    Thinking animation
    Only for reasoning (long load time) models for now
*/

const ThinkingIndicator = ({ historyItem }: ThinkingIndicatorProps) => {
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const phrase = useThinkingPhrase();

  const hasContent = Array.isArray(historyItem.message.content)
    ? !!historyItem.message.content.length
    : !!historyItem.message.content;
  const isThinking =
    isStreaming && !historyItem.isGatheringContext && !hasContent;
  if (!isThinking) {
    return null;
  }

  return (
    <div className="cukii-thinking-row px-2 py-2">
      <CukiiThinkingGlyph />
      <span className="cukii-thinking-text">{phrase}</span>
    </div>
  );
};

export default ThinkingIndicator;
