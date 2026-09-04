import type { CukiiSessionAttention } from "core/protocol/ideWebview";

/**
 * Host-side answer to "what is this session doing right now?", which the
 * session drawer's Active chip and Needs input / Working / Completed filters
 * are built on.
 *
 * The two facts that make a session non-idle live in different places and
 * neither is visible to the sidebar webview: the bridge run coordinator knows
 * a vendor process is streaming, and the Claude permission broker knows a
 * prompt is waiting for an answer. This registry is where they meet.
 *
 * Both are tracked as sets rather than flags. A replacement run overlaps its
 * predecessor for as long as the old one takes to die, and a single turn can
 * have several permission prompts outstanding; a boolean would flip to idle on
 * the first of them to finish and the drawer would say "completed" while the
 * vendor was still working.
 */
export class CukiiSessionAttentionRegistry {
  private readonly runs = new Map<string, Set<string>>();
  private readonly prompts = new Map<string, Set<string>>();
  private readonly listeners = new Set<() => void>();

  /** Needs input outranks working: it is the one the user must act on. */
  attentionFor(sessionId: string): CukiiSessionAttention {
    if ((this.prompts.get(sessionId)?.size ?? 0) > 0)
      return "pending-permission";
    if ((this.runs.get(sessionId)?.size ?? 0) > 0) return "streaming";
    return "none";
  }

  runStarted(sessionId: string, runId: string): void {
    this.mutate(this.runs, sessionId, (ids) => ids.add(runId));
  }

  runEnded(sessionId: string, runId: string): void {
    this.mutate(this.runs, sessionId, (ids) => ids.delete(runId));
  }

  /**
   * The full set of prompts a broker is waiting on, as the broker sees it.
   * Replacing rather than incrementing is deliberate: the broker settles
   * requests on its own timeout and on denyAll(), and a caller that only ever
   * heard about openings would leave the drawer stuck on "Needs input".
   */
  promptsChanged(sessionId: string, requestIds: readonly string[]): void {
    this.mutate(this.prompts, sessionId, (ids) => {
      ids.clear();
      for (const id of requestIds) ids.add(id);
    });
  }

  /** A closed panel or a disposed broker owes the user nothing. */
  forgetSession(sessionId: string): void {
    const had = this.runs.delete(sessionId);
    const alsoHad = this.prompts.delete(sessionId);
    if (had || alsoHad) this.emit();
  }

  onChange(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private mutate(
    store: Map<string, Set<string>>,
    sessionId: string,
    change: (ids: Set<string>) => void,
  ): void {
    if (!sessionId) return;
    const before = this.attentionFor(sessionId);
    const ids = store.get(sessionId) ?? new Set<string>();
    change(ids);
    if (ids.size === 0) store.delete(sessionId);
    else store.set(sessionId, ids);
    // Listeners repaint the whole drawer, so only a visible transition is
    // worth waking them for — a second concurrent run is not one.
    if (this.attentionFor(sessionId) !== before) this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const cukiiSessionAttention = new CukiiSessionAttentionRegistry();
