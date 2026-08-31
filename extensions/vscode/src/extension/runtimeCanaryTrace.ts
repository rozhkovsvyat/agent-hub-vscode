import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { ChatMessage } from "core";

const CANARY_ENVELOPE =
  /^\s*\[\[CUKII_RUNTIME_CANARY turn_id=([A-Za-z0-9_-]{12,128}) nonce=([A-Za-z0-9_-]{16,128})\]\]/;

export type RuntimeCanaryTurn = {
  turnId: string;
  nonce: string;
};

export type RuntimeCanaryEventName =
  | "ui_submit"
  | "bridge_dispatch"
  | "vendor_completed";

export type RuntimeCanaryResult = "completed" | "provider_quota" | "failed";

export type RuntimeCanaryExtensionBinding = {
  extensionId: "cukii.cukii-vscode";
  extensionRoot: string;
  extensionVersion: string;
  manifestSha256: string;
};

type RuntimeCanaryEvent = {
  schema: "cukii.runtime-canary-event/v1";
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
};

function userText(message: ChatMessage): string | undefined {
  if (typeof message.content === "string") return message.content;
  return undefined;
}

/**
 * Runtime receipts are opt-in. The envelope is deliberately part of the exact
 * user turn, so a later trace cannot be attached to an arbitrary request. Do
 * not persist ordinary prompts or their contents in the canary trace.
 */
export function runtimeCanaryTurn(
  messages: ChatMessage[],
): RuntimeCanaryTurn | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = userText(message);
    const match = text?.match(CANARY_ENVELOPE);
    if (match) return { turnId: match[1], nonce: match[2] };
    return undefined;
  }
  return undefined;
}

export class RuntimeCanaryTrace {
  private sequence = 0;

  constructor(
    private readonly turn: RuntimeCanaryTurn,
    private readonly model: string,
    private readonly extension: RuntimeCanaryExtensionBinding,
    private readonly tracePath = path.join(
      process.env.CUKII_RUNTIME_CANARY_TRACE_DIR ??
        path.join(os.homedir(), ".agent-hub", "cukii-runtime-canary"),
      "events.jsonl",
    ),
  ) {}

  record(
    event: RuntimeCanaryEventName,
    details: Pick<RuntimeCanaryEvent, "result" | "exit_code"> = {},
  ): void {
    const entry: RuntimeCanaryEvent = {
      schema: "cukii.runtime-canary-event/v1",
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
    };
    fs.mkdirSync(path.dirname(this.tracePath), { recursive: true });
    fs.appendFileSync(this.tracePath, `${JSON.stringify(entry)}\n`, "utf8");
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
