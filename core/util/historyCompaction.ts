const TERMINAL_TOOL_STATUSES = new Set(["done", "errored", "canceled"]);

type PersistableSession = {
  history: Array<{
    message: { role: string; toolCallId?: string };
    toolCallStates?: Array<{
      status: string;
      toolCallId?: string;
      toolCall?: { id?: string };
    }>;
  }>;
};

/**
 * Tool results are represented twice while a turn is streaming: once as an
 * invisible `role: tool` transport row and once in the matching assistant
 * `toolCallStates`, which is what both the timeline and the next model turn
 * reconstruct. Persisting both copies made long broker sessions hundreds of
 * megabytes and blocked every panel while SQLite rewrote the JSON blob.
 *
 * Drop only a transport row whose terminal state is present. Unknown,
 * unmatched, or still-running rows stay intact so schema drift and mid-turn
 * recovery fail closed instead of losing output.
 */
export function compactSessionForPersistence<T extends PersistableSession>(
  session: T,
): T {
  const terminalToolCallIds = new Set<string>();
  for (const item of session.history) {
    for (const state of item.toolCallStates ?? []) {
      if (!TERMINAL_TOOL_STATUSES.has(String(state.status))) continue;
      const id = String(state.toolCall?.id ?? state.toolCallId ?? "");
      if (id) terminalToolCallIds.add(id);
    }
  }

  if (!terminalToolCallIds.size) return session;
  const history = session.history.filter((item) => {
    if (item.message.role !== "tool") return true;
    const toolCallId = String(item.message.toolCallId ?? "");
    return !toolCallId || !terminalToolCallIds.has(toolCallId);
  });
  return history.length === session.history.length
    ? session
    : ({ ...session, history } as T);
}
