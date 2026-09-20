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

/**
 * True when this argv is a native resume rather than a cold start.
 * Claude uses `--resume`; Kimi 2.0 uses `--session`/`-S` (and still accepts
 * the 0.38 resume_hint spelling `-r`).
 */
export function argvRequestsVendorResume(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--resume" ||
      arg === "--session" ||
      arg === "-S" ||
      arg === "-r" ||
      arg.startsWith("--session="),
  );
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

/**
 * True when the vendor reports that the remembered native session is gone and
 * `--resume` can never succeed: Claude prints "unknown session"/"no
 * conversation found", while Codex 0.4x rollout errors say
 * `thread <uuid> not found` (card 7864160e: the run died instead of the next
 * turn cold-starting). Any other failure text must not drop the resume id.
 */
export function isVendorSessionLossError(detail: string): boolean {
  return /unknown session|session not found|session\s+"[^"]+"\s+not found|no conversation found|thread\s+[\w-]{8,}\s+not found/i.test(
    detail,
  );
}

/** Test-only: drop in-memory resume ids between cases. */
export function resetVendorSessionsForTests(): void {
  remembered.clear();
}
