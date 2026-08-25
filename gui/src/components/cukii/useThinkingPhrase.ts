import { useEffect, useState } from "react";

/**
 * Печатающаяся фраза статуса Cukii.
 *
 * Логика жила копиями в ThinkingIndicator и ThinkingBlockPeek, а теперь нужна
 * ещё и нижней строке — три копии разъехались бы по таймингам и набору фраз.
 */
export const CUKII_THINKING_PHRASES = [
  "Thinking",
  "Combulating",
  "Sussing",
  "Sifting crumbs",
  "Warming context",
  "Checking the bite",
];

// Фраза должна успеть прочитаться: прошлые 0.56 s между надписями выглядели как
// лихорадочная печать и постоянно обрывали слово на середине.
const PHRASE_HOLD_MS = 2_200;

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
