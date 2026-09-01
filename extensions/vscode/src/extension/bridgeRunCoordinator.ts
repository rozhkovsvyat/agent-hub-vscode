import type { BrokerModel } from "core/protocol/ideWebview";

export type BridgeRunIdentity = {
  runId: string;
  sessionId: string;
  brokerModel: BrokerModel;
};

export type BridgeRunAcquireResult =
  | "acquired"
  | "superseded"
  | "blocked";

type Slot<Run extends BridgeRunIdentity> = {
  active?: Run;
  latestTicket: number;
  cancellation?: {
    runId: string;
    promise: Promise<boolean>;
  };
};

function bounded(
  operation: Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    void operation.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/**
 * Serializes native bridge replacement per webview without building a
 * previous.done linked list. Concurrent replacements share one cancellation
 * barrier and only the latest candidate may acquire the slot afterwards.
 */
export class BridgeRunCoordinator<
  Key,
  Run extends BridgeRunIdentity,
> {
  private readonly slots = new Map<Key, Slot<Run>>();

  constructor(private readonly replacementTimeoutMs = 12_000) {}

  activeFor(key: Key): Run | undefined {
    return this.slots.get(key)?.active;
  }

  async acquire(
    key: Key,
    candidate: Run,
    cancel: (run: Run) => Promise<boolean>,
  ): Promise<BridgeRunAcquireResult> {
    const slot = this.slotFor(key);
    const ticket = ++slot.latestTicket;

    while (true) {
      if (ticket !== slot.latestTicket) return "superseded";

      const active = slot.active;
      if (!active) {
        slot.active = candidate;
        return "acquired";
      }
      if (active.runId === candidate.runId) return "acquired";

      let cancellation = slot.cancellation;
      if (!cancellation || cancellation.runId !== active.runId) {
        cancellation = {
          runId: active.runId,
          promise: bounded(cancel(active), this.replacementTimeoutMs),
        };
        slot.cancellation = cancellation;
      }

      const cancelled = await cancellation.promise;
      if (slot.cancellation === cancellation) {
        slot.cancellation = undefined;
      }
      if (!cancelled) return "blocked";
      if (slot.active?.runId === active.runId) {
        slot.active = undefined;
      }
    }
  }

  release(key: Key, run: Run): void {
    const slot = this.slots.get(key);
    if (!slot || slot.active?.runId !== run.runId) return;
    slot.active = undefined;
    if (!slot.cancellation) this.deleteIfIdle(key, slot);
  }

  forget(key: Key): void {
    this.slots.delete(key);
  }

  private slotFor(key: Key): Slot<Run> {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { latestTicket: 0 };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private deleteIfIdle(key: Key, slot: Slot<Run>): void {
    if (slot.active || slot.cancellation) return;
    this.slots.delete(key);
  }
}

export function bridgeRunAcceptsSteer<Run extends BridgeRunIdentity>(
  run: Run | undefined,
  request: { sessionId: string; brokerModel?: BrokerModel },
): run is Run {
  return Boolean(
    run &&
      run.sessionId === request.sessionId &&
      request.brokerModel &&
      run.brokerModel === request.brokerModel,
  );
}
