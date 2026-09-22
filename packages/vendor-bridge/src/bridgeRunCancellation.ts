export type InterruptKind = "turn" | "tool";

/** Owns the exactly-once cancellation receipt for one native bridge run. */
export class BridgeRunCancellation {
  private readonly activeToolIds = new Set<string>();
  private cancellation: Promise<{ interrupted: InterruptKind }> | undefined;
  private interrupted: InterruptKind | undefined;

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
    interrupted: InterruptKind;
    receipt: Promise<{ interrupted: InterruptKind }>;
  } {
    const alreadyCancelled = Boolean(this.cancellation);
    this.interrupted ??= this.activeToolIds.size ? "tool" : "turn";
    const interrupted = this.interrupted;
    this.cancellation ??= (async () => {
      this.abort();
      await this.done;
      return { interrupted };
    })();
    return { alreadyCancelled, interrupted, receipt: this.cancellation };
  }
}
