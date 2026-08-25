import { useThinkingPhrase } from "../../../cukii/useThinkingPhrase";
import { CukiiThinkingGlyph } from "../../../cukii/CukiiThinkingGlyph";

/**
 * Живой лоадер текущего ответа: самая нижняя строка хода.
 *
 * Thinking — отдельная надпись выше. Стоп — квадрат в поле ввода, Esc.
 */
export function CukiiStreamingToolbar() {
  const phrase = useThinkingPhrase();

  return (
    <div
      className="flex w-full min-w-0 items-center"
      data-testid="cukii-streaming-toolbar"
    >
      <div className="cukii-thinking-row min-w-0">
        <CukiiThinkingGlyph />
        <span className="cukii-thinking-text truncate">{phrase}...</span>
      </div>
    </div>
  );
}
