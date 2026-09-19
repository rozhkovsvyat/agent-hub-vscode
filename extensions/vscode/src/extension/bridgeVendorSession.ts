import type { BrokerModel } from "core/protocol/ideWebview";

/**
 * Native CLI session ids captured from a structured init/thread envelope.
 * Used on the next turn of the same Cukii session + model so Claude can
 * `--resume` instead of re-paying the full prompt as a cold start.
 */
const VENDOR_SESSION_ID = /^[A-Za-z0-9._:-]{8,128}$/;

const remembered = new Map<string, string>();

function key(sessionId: string, model: BrokerModel): string {
  return `${sessionId}\n${model}`;
}

export function isVendorSessionId(value: string): boolean {
  return VENDOR_SESSION_ID.test(value);
}

export function rememberVendorSession(
  sessionId: string,
  model: BrokerModel,
  vendorSessionId: string,
): void {
  if (!sessionId || !isVendorSessionId(vendorSessionId)) return;
  remembered.set(key(sessionId, model), vendorSessionId);
}

export function rememberedVendorSession(
  sessionId: string,
  model: BrokerModel,
): string | undefined {
  return remembered.get(key(sessionId, model));
}

export function forgetVendorSession(
  sessionId: string,
  model: BrokerModel,
): void {
  remembered.delete(key(sessionId, model));
}

/** Test-only: drop in-memory resume ids between cases. */
export function resetVendorSessionsForTests(): void {
  remembered.clear();
}
