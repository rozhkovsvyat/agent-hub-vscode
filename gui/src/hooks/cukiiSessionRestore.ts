import type { Session } from "core";

/**
 * Cukii only surfaces a session after its first real exchange has been saved.
 * Consequently an empty HistoryManager fallback denotes a missing/failed
 * restore, not a session that may be represented by a blank editor tab.
 */
export function isRestorableCukiiSession(
  session: Session | undefined,
): session is Session {
  return Boolean(session && session.history.length > 0);
}
