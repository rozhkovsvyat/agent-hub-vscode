export type InterruptKind = "turn" | "tool";

/** Owns the exactly-once cancellation receipt for one native bridge run. */
export class BridgeRunCancellation {
  private readonly activeToolIds = new Set<string>();
  private cancellation: Promise<{ interrupted: InterruptKind }> | undefined;

  constructor(
    private readonly abort: () => void,
    private readonly done: Promise<void>,
  ) {}

  toolStarted(id: string): void {
    this.activeToolIds.add(id);
  }

  toolFinished(id: string): void {
    this.activeToolIds.delete(id);
  }

  cancel(): {
    alreadyCancelled: boolean;
    receipt: Promise<{ interrupted: InterruptKind }>;
  } {
    const alreadyCancelled = Boolean(this.cancellation);
    this.cancellation ??= (async () => {
      const interrupted = this.activeToolIds.size ? "tool" : "turn";
      this.abort();
      await this.done;
      return { interrupted };
    })();
    return { alreadyCancelled, receipt: this.cancellation };
  }
}
