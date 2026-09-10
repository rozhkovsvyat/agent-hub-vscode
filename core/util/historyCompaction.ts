const TERMINAL_TOOL_STATUSES = new Set(["done", "errored", "canceled"]);

type PersistableSession = {
  history: Array<{
    message: { role: string; content?: unknown; toolCallId?: string };
    toolCallStates?: Array<{
      status: string;
      toolCallId?: string;
      toolCall?: { id?: string };
      output?: Array<{ content?: unknown }>;
    }>;
  }>;
};

type ToolResultEvidence = {
  outputText?: string;
  terminal: boolean;
};

function textContent(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stateOutputText(
  output: Array<{ content?: unknown }> | undefined,
): string | undefined {
  if (!output?.length) return undefined;
  const parts = output.map((item) => textContent(item.content));
  return parts.some((part) => part === undefined)
    ? undefined
    : (parts as string[]).join("\n");
}

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
  const latestToolEvidence = new Map<string, ToolResultEvidence>();
  let changed = false;
  const history = session.history.filter((item) => {
    if (item.message.role === "user") latestToolEvidence.clear();
    for (const state of item.toolCallStates ?? []) {
      const id = String(state.toolCall?.id ?? state.toolCallId ?? "");
      if (!id) continue;
      latestToolEvidence.set(id, {
        terminal: TERMINAL_TOOL_STATUSES.has(String(state.status)),
        outputText: stateOutputText(state.output),
      });
    }
    if (item.message.role !== "tool") return true;
    const toolCallId = String(item.message.toolCallId ?? "");
    const evidence = latestToolEvidence.get(toolCallId);
    const toolText = textContent(item.message.content);
    const isProvenDuplicate =
      Boolean(toolCallId) &&
      evidence?.terminal === true &&
      evidence.outputText !== undefined &&
      toolText !== undefined &&
      evidence.outputText === toolText;
    if (isProvenDuplicate) changed = true;
    return !isProvenDuplicate;
  });
  return changed ? ({ ...session, history } as T) : session;
}
