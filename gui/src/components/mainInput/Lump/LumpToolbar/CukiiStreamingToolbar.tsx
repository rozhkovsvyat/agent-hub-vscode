import { useThinkingPhrase } from "../../../cukii/useThinkingPhrase";
import { CukiiCrumbs } from "../../../cukii/CukiiCrumbs";

/**
 * Живой лоадер текущего ответа: самая нижняя строка хода.
 *
 * Thinking — отдельная надпись выше. Стоп — квадрат в поле ввода, Esc.
 */
export function CukiiStreamingToolbar({ active = true }: { active?: boolean }) {
  const phrase = useThinkingPhrase(active);

  return (
    <div
      className="flex w-full min-w-0 items-center"
      data-testid="cukii-streaming-toolbar"
    >
      <div className="cukii-thinking-row min-w-0">
        <CukiiCrumbs active={active} />
        <span className="cukii-thinking-text truncate">{phrase}..</span>
      </div>
    </div>
  );
}
