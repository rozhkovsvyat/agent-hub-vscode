import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { useThinkingPhrase } from "../../../cukii/useThinkingPhrase";
import { CukiiThinkingGlyph } from "../../../cukii/CukiiThinkingGlyph";

interface CukiiStreamingToolbarProps {
  onStop: () => void;
}

/**
 * Постоянная нижняя строка статуса на время всего ответа.
 *
 * До этого анимация жила только внутри блока размышлений и пропадала, как только
 * у сообщения появлялся контент или карточка инструмента: дальше ответ шёл молча,
 * и выглядело это как «зависло на Agent tool use». Здесь строка держится до конца
 * стрима — как в плагине Клода — и всегда даёт способ остановить ответ.
 */
export function CukiiStreamingToolbar({ onStop }: CukiiStreamingToolbarProps) {
  const phrase = useThinkingPhrase();
  const jetbrains = isJetBrains();

  return (
    <div className="flex w-full min-w-0 items-center justify-between">
      <div className="cukii-thinking-row min-w-0">
        <CukiiThinkingGlyph />
        <span className="cukii-thinking-text truncate">{phrase}</span>
      </div>
      <div
        onClick={onStop}
        className="text-2xs flex-shrink-0 cursor-pointer px-1.5 py-0.5 hover:brightness-125"
      >
        <span className="text-description">Stop</span>
        <span className="text-description-muted ml-1 opacity-75">
          {jetbrains ? getAltKeyLabel() : getMetaKeyLabel()}⌫
        </span>
      </div>
    </div>
  );
}
