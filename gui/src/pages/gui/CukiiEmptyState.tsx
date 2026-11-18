import { CukiiMark } from "../../components/cukii/CukiiMark";

export const CUKII_EMPTY_STATE_MESSAGES = [
  "Fresh batch. Let’s build.",
  "New context. Zero crumbs.",
  "Dunk in. Ship clean.",
  "One cookie closer to done.",
  "Warm cache. Cold milk.",
  "Break the problem, not the cookie.",
  "Fresh session. Sharp tools.",
  "Baked for the long run.",
  "Follow the crumbs.",
  "Pour the context. Start building.",
] as const;

export function cukiiEmptyStateMessage(sessionId?: string): string {
  if (!sessionId) return CUKII_EMPTY_STATE_MESSAGES[0];
  let hash = 2166136261;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return CUKII_EMPTY_STATE_MESSAGES[
    (hash >>> 0) % CUKII_EMPTY_STATE_MESSAGES.length
  ];
}

/** Welcome shown when the thread is empty. Not Continue onboarding cards. */
export function CukiiEmptyState({ sessionId }: { sessionId?: string }) {
  return (
    <div
      className="mx-auto flex min-h-0 w-full max-w-md flex-1 items-center justify-center text-center"
      data-testid="cukii-empty-state"
    >
      <div className="flex w-full max-w-[266px] translate-y-[5px] flex-col items-center gap-6">
        <CukiiMark size={46} />
        <div className="whitespace-normal text-[13px] leading-[20.8px] text-[var(--vscode-foreground)]">
          {cukiiEmptyStateMessage(sessionId)}
        </div>
      </div>
    </div>
  );
}
