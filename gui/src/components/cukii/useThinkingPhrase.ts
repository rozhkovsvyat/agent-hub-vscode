import { useEffect, useState } from "react";

/**
 * Печатающаяся фраза живого лоадера стрима.
 *
 * Это именно Cukii-голос, а не заимствованный набор фраз другого продукта.
 */
export const CUKII_THINKING_PHRASES = [
  "Crumbing through it",
  "Combulating",
  "Cookie calculus",
  "Sifting crumbs",
  "Baking context",
  "Tasting the trail",
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
