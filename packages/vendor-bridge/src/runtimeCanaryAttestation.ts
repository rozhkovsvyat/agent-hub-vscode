import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ChatMessage } from "core";

const CANARY_ENVELOPE =
  /^\s*\[\[CUKII_RUNTIME_CANARY turn_id=([A-Za-z0-9_-]{12,128}) nonce=([A-Za-z0-9_-]{16,128})\]\]/;

export type RuntimeCanaryTurn = {
  turnId: string;
  nonce: string;
};

export type RuntimeCanaryEventName = "bridge_dispatch" | "vendor_completed";

export type RuntimeCanaryResult = "completed" | "provider_quota" | "failed";

export type RuntimeCanaryExtensionBinding = {
  extensionId: "cukii.cukii-vscode";
  extensionRoot: string;
  extensionVersion: string;
  manifestSha256: string;
};

export type RuntimeCanaryEvent = {
  schema: "cukii.runtime-canary-attestation/v1";
  turn_id: string;
  nonce: string;
  seq: number;
  observed_at: string;
  event: RuntimeCanaryEventName;
  vendor: "kimi";
  model: string;
  extension_id: "cukii.cukii-vscode";
  extension_root: string;
  extension_version: string;
  manifest_sha256: string;
  result?: RuntimeCanaryResult;
  exit_code?: number | null;
  response_sha256?: string;
  response_length?: number;
};

export type RuntimeCanaryReporter = (event: RuntimeCanaryEvent) => void;

function userText(message: ChatMessage): string | undefined {
  return typeof message.content === "string" ? message.content : undefined;
}

/**
 * The runner arms a local CDP observer before the user sends this envelope.
 * Only Kimi turns opt in; ordinary prompts never produce harness traffic.
 */
export function runtimeCanaryTurn(
  messages: ChatMessage[],
): RuntimeCanaryTurn | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") {
      continue;
    }
    const match = userText(message)?.match(CANARY_ENVELOPE);
    if (match) {
      return { turnId: match[1], nonce: match[2] };
    }
    return undefined;
  }
  return undefined;
}

/**
 * This object intentionally has no file sink.  Remote-SSH filesystem data is
 * not an attestation channel: the registered reporter sends the event through
 * the already-open extension -> local webview transport, where the local CDP
 * controller owns the nonce and receipt HMAC.
 */
export class RuntimeCanaryAttestation {
  private sequence = 0;

  constructor(
    private readonly turn: RuntimeCanaryTurn,
    private readonly model: string,
    private readonly extension: RuntimeCanaryExtensionBinding,
    private readonly report: RuntimeCanaryReporter | undefined,
  ) {}

  record(
    event: RuntimeCanaryEventName,
    details: Pick<
      RuntimeCanaryEvent,
      "result" | "exit_code" | "response_sha256" | "response_length"
    > = {},
  ): void {
    this.report?.({
      schema: "cukii.runtime-canary-attestation/v1",
      turn_id: this.turn.turnId,
      nonce: this.turn.nonce,
      seq: ++this.sequence,
      observed_at: new Date().toISOString(),
      event,
      vendor: "kimi",
      model: this.model,
      extension_id: this.extension.extensionId,
      extension_root: this.extension.extensionRoot,
      extension_version: this.extension.extensionVersion,
      manifest_sha256: this.extension.manifestSha256,
      ...details,
    });
  }
}

export function runtimeCanaryExtensionBinding(
  extensionRoot: string,
  extensionVersion: string,
): RuntimeCanaryExtensionBinding | undefined {
  const manifest = path.join(extensionRoot, "package.json");
  try {
    return {
      extensionId: "cukii.cukii-vscode",
      extensionRoot,
      extensionVersion,
      manifestSha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(manifest))
        .digest("hex"),
    };
  } catch {
    return undefined;
  }
}

export function runtimeCanaryResult(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): RuntimeCanaryResult {
  if (
    /\b(quota|rate[_ -]?limit|too many requests)\b/i.test(
      `${stdout}\n${stderr}`,
    )
  ) {
    return "provider_quota";
  }
  return exitCode === 0 ? "completed" : "failed";
}

export function runtimeCanaryResponseSummary(text: string): {
  response_sha256: string;
  response_length: number;
} {
  return {
    response_sha256: crypto
      .createHash("sha256")
      .update(text, "utf8")
      .digest("hex"),
    response_length: text.length,
  };
}
