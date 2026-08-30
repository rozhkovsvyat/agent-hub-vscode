import type { CukiiSteerReceipt } from "core/protocol/ideWebview";

export type SteerMessage = {
  messageId: string;
  sessionId: string;
  text: string;
};

export type SteerWriter = (text: string) => Promise<boolean>;

type PendingSteer = {
  message: SteerMessage;
  resolve: (receipt: CukiiSteerReceipt) => void;
};

/** Per-run steering ledger. Message ids make transport retries idempotent. */
export class BridgeSteeringController {
  private readonly receipts = new Map<string, Promise<CukiiSteerReceipt>>();
  private readonly pending: PendingSteer[] = [];
  private writer: SteerWriter | undefined;
  private inFlight: PendingSteer | undefined;
  private closed = false;
  private flushing = false;

  constructor(
    readonly sessionId: string,
    readonly supportsLiveSteering: boolean,
  ) {}

  deliver(message: SteerMessage): Promise<CukiiSteerReceipt> {
    const duplicate = this.receipts.get(message.messageId);
    if (duplicate) return duplicate;
    const receipt = new Promise<CukiiSteerReceipt>((resolve) => {
      if (
        this.closed ||
        !this.supportsLiveSteering ||
        message.sessionId !== this.sessionId ||
        !message.text.trim()
      ) {
        resolve(this.deferred(message));
        return;
      }
      this.pending.push({ message, resolve });
      void this.flush();
    });
    this.receipts.set(message.messageId, receipt);
    return receipt;
  }

  attachWriter(writer: SteerWriter): void {
    if (this.closed || !this.supportsLiveSteering) return;
    this.writer = writer;
    void this.flush();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer = undefined;
    if (this.inFlight) {
      this.inFlight.resolve(this.deferred(this.inFlight.message));
    }
    for (const pending of this.pending.splice(0)) {
      pending.resolve(this.deferred(pending.message));
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    const writer = this.writer;
    if (!writer || this.closed) return;
    this.flushing = true;
    try {
      while (this.pending.length && this.writer === writer && !this.closed) {
        const pending = this.pending.shift()!;
        this.inFlight = pending;
        let delivered = false;
        try {
          delivered = await writer(pending.message.text);
        } catch {
          delivered = false;
        }
        pending.resolve(
          delivered && !this.closed
            ? {
                messageId: pending.message.messageId,
                sessionId: this.sessionId,
                status: "delivered",
              }
            : this.deferred(pending.message),
        );
        if (this.inFlight === pending) this.inFlight = undefined;
      }
    } finally {
      this.flushing = false;
      if (this.pending.length && this.writer && !this.closed) void this.flush();
    }
  }

  private deferred(message: SteerMessage): CukiiSteerReceipt {
    return {
      messageId: message.messageId,
      sessionId: message.sessionId,
      status: "deferred",
    };
  }
}
