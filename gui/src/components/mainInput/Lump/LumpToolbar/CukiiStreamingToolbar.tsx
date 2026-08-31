import { useThinkingPhrase } from "../../../cukii/useThinkingPhrase";
import { CukiiCrumbs } from "../../../cukii/CukiiCrumbs";

export type CukiiWaitReceipt = {
  condition: string;
  deadline?: string;
};

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

export function splitThinkingPhrase(phrase: string): string[] {
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(phrase), ({ segment }) => segment)
    : Array.from(phrase);
}

/**
 * Живой лоадер текущего ответа: самая нижняя строка хода.
 *
 * Thinking — отдельная надпись выше. Стоп — квадрат в поле ввода, Esc.
 */
export function CukiiStreamingToolbar({
  active = true,
  wait,
}: {
  active?: boolean;
  wait?: CukiiWaitReceipt;
}) {
  const phrase = useThinkingPhrase(active && !wait);
  const announcement = `${phrase}..`;

  if (wait) {
    return null;
  }

  return (
    <div
      className="flex w-full min-w-0 items-center"
      data-testid="cukii-streaming-toolbar"
    >
      <div className="cukii-thinking-row min-w-0">
        <CukiiCrumbs active={active} />
        <span className="cukii-thinking-text" aria-hidden="true">
          {splitThinkingPhrase(announcement).map((grapheme, index) =>
            /^\s$/u.test(grapheme) ? (
              <span
                className="cukii-thinking-space"
                data-testid="cukii-thinking-space"
                key={`${phrase}-${index}`}
              >
                {grapheme}
              </span>
            ) : (
              <span
                className="cukii-thinking-character"
                key={`${phrase}-${index}`}
                style={{ animationDelay: `${index * 18}ms` }}
              >
                {grapheme}
              </span>
            ),
          )}
        </span>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </span>
      </div>
    </div>
  );
}

/** Static receipt for an explicit native pause — intentionally no Crumbs. */
export function CukiiWaitingReceipt({ wait }: { wait: CukiiWaitReceipt }) {
  return (
    <div
      aria-live="polite"
      className="cukii-waiting-receipt text-description px-2 py-2 text-xs"
      data-testid="cukii-waiting-receipt"
      role="status"
    >
      <span>Cukii is waiting — {wait.condition}</span>
      {wait.deadline && <span> · until {wait.deadline}</span>}
    </div>
  );
}
