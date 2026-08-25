import { useEffect, useState } from "react";

/**
 * Печатающаяся фраза живого лоадера стрима.
 *
 * Thinking-надпись этим хуком больше не пользуется: она должна говорить
 * «Thinking», а не притворяться вторым лоадером.
 */
export const CUKII_THINKING_PHRASES = [
  "Thinking",
  "Combulating",
  "Sussing",
  "Sifting crumbs",
  "Warming context",
  "Checking the bite",
];

// Фраза должна успеть прочитаться: держим её ~4 s, как у Claude Code, —
// прошлые короткие интервалы выглядели как лихорадочная печать.
const PHRASE_HOLD_MS = 4_000;

export function useThinkingPhrase(active = true): string {
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setTimeout(() => {
      setPhraseIndex(
        (current) => (current + 1) % CUKII_THINKING_PHRASES.length,
      );
    }, PHRASE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [active, phraseIndex]);

  return CUKII_THINKING_PHRASES[phraseIndex];
}
