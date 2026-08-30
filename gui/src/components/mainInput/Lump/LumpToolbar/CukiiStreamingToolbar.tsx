import { useThinkingPhrase } from "../../../cukii/useThinkingPhrase";
import { CukiiCrumbs } from "../../../cukii/CukiiCrumbs";

/**
 * Живой лоадер текущего ответа: самая нижняя строка хода.
 *
 * Thinking — отдельная надпись выше. Стоп — квадрат в поле ввода, Esc.
 */
export function CukiiStreamingToolbar({ active = true }: { active?: boolean }) {
  const phrase = useThinkingPhrase(active);
  const announcement = `${phrase}..`;

  return (
    <div
      className="flex w-full min-w-0 items-center"
      data-testid="cukii-streaming-toolbar"
    >
      <div className="cukii-thinking-row min-w-0">
        <CukiiCrumbs active={active} />
        <span className="cukii-thinking-text" aria-hidden="true">
          {announcement.split("").map((character, index) => (
            <span
              className="cukii-thinking-character"
              key={`${phrase}-${index}`}
              style={{ animationDelay: `${index * 18}ms` }}
            >
              {character}
            </span>
          ))}
        </span>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </div>
    </div>
  );
}
