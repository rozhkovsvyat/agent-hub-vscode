import type { MessageContent } from "core";
import type { CukiiSteerReceipt } from "core/protocol/ideWebview";
import { hasImageAttachments, stripImages } from "core/util/messageContent";

export type SteerMessage = {
  messageId: string;
  sessionId: string;
  content: MessageContent;
};

export type SteerWriter = (message: SteerMessage) => Promise<boolean>;

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
  /** Inputs accepted by stdin but not yet explicitly echoed by the vendor. */
  private readonly awaitingVendorEcho: SteerMessage[] = [];
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
        (!stripImages(message.content).trim() &&
          !hasImageAttachments(message.content))
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
    this.awaitingVendorEcho.length = 0;
    if (this.inFlight) {
      this.inFlight.resolve(this.deferred(this.inFlight.message));
    }
    for (const pending of this.pending.splice(0)) {
      pending.resolve(this.deferred(pending.message));
    }
  }

  /**
   * Returns one receipt only when the vendor echoes the exact user envelope
   * it received. This is intentionally stricter than "some stdout arrived":
   * adjacent queued follow-ups can therefore never get a premature second
   * checkmark from another turn's tool/text output.
   */
  consumeVendorEcho(text: string): string | undefined {
    const index = this.awaitingVendorEcho.findIndex(
      (message) => stripImages(message.content) === text,
    );
    if (index < 0) return undefined;
    const messageId = this.awaitingVendorEcho.splice(index, 1)[0].messageId;
    // A duplicate text is held in FIFO until this exact echo retires the
    // earlier message. Without that gate, two equal strings have no vendor
    // identifier and an out-of-order echo could paint ✓✓ on the wrong bubble.
    void this.flush();
    return messageId;
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    const writer = this.writer;
    if (!writer || this.closed) return;
    this.flushing = true;
    try {
      while (this.pending.length && this.writer === writer && !this.closed) {
        const next = this.pending[0];
        // Native user envelopes carry text, not the Cukii message id. Keep
        // equal follow-ups serialized until their predecessor is observed.
        if (
          this.awaitingVendorEcho.some(
            (awaiting) =>
              stripImages(awaiting.content) ===
              stripImages(next.message.content),
          )
        ) {
          break;
        }
        const pending = this.pending.shift()!;
        this.inFlight = pending;
        let delivered = false;
        try {
          delivered = await writer(pending.message);
        } catch {
          delivered = false;
        }
        if (delivered && !this.closed) {
          this.awaitingVendorEcho.push(pending.message);
          pending.resolve({
            messageId: pending.message.messageId,
            sessionId: this.sessionId,
            status: "delivered",
          });
        } else {
          pending.resolve(this.deferred(pending.message));
        }
        if (this.inFlight === pending) this.inFlight = undefined;
      }
    } finally {
      this.flushing = false;
      const next = this.pending[0];
      if (
        next &&
        this.writer &&
        !this.closed &&
        !this.awaitingVendorEcho.some(
          (awaiting) =>
            stripImages(awaiting.content) === stripImages(next.message.content),
        )
      ) {
        void this.flush();
      }
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
