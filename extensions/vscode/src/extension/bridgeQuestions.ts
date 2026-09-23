import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  CukiiUserQuestionRequest,
  CukiiUserQuestionResponse,
} from "core/protocol/ideWebview";
import {
  readRunBindingForPid,
  type CukiiRunBinding,
} from "@cukii/vendor-bridge";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
/** How often a still-unanswered request is re-published to the panel. */
export const RENOTIFY_INTERVAL_MS = 10_000;

type QuestionRecord = {
  id: string;
  sessionId: string;
  runId: string;
  producerNonce: string;
  createdMs: number;
  status: "pending" | "answered" | "cancelled";
  questions: CukiiUserQuestionRequest["questions"];
  answers?: Record<string, string>;
  reason?: string;
};

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function validQuestions(
  value: unknown,
): value is CukiiUserQuestionRequest["questions"] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3)
    return false;
  const ids = new Set<string>();
  return value.every((question) => {
    if (
      typeof question !== "object" ||
      question === null ||
      !SAFE_SEGMENT.test((question as { id?: string }).id ?? "") ||
      ids.has((question as { id: string }).id) ||
      !boundedText((question as { header?: unknown }).header, 80) ||
      !boundedText((question as { question?: unknown }).question, 4096)
    ) {
      return false;
    }
    ids.add((question as { id: string }).id);
    const options = (question as { options?: unknown }).options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 3) {
      return false;
    }
    const labels = new Set<string>();
    return options.every((option) => {
      if (typeof option !== "object" || option === null) return false;
      const label = (option as { label?: unknown }).label;
      if (!boundedText(label, 80) || labels.has(label)) return false;
      labels.add(label);
      return boundedText(
        (option as { description?: unknown }).description,
        1024,
      );
    });
  });
}

export function bridgeQuestionsRoot(): string {
  return (
    process.env.CUKII_QUESTIONS_DIR ||
    path.join(os.homedir(), ".continue", "cukii-questions")
  );
}

function sessionDirectory(sessionId: string): string | undefined {
  if (!SAFE_SEGMENT.test(sessionId)) return undefined;
  return path.join(bridgeQuestionsRoot(), sessionId);
}

function questionFingerprint(record: QuestionRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: record.id,
        sessionId: record.sessionId,
        runId: record.runId,
        producerNonce: record.producerNonce,
        createdMs: record.createdMs,
        questions: record.questions,
      }),
    )
    .digest("hex");
}

function readRecord(file: string): QuestionRecord | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as QuestionRecord;
    if (
      SAFE_SEGMENT.test(record?.id ?? "") &&
      SAFE_SEGMENT.test(record?.sessionId ?? "") &&
      SAFE_SEGMENT.test(record?.runId ?? "") &&
      /^[a-f0-9]{64}$/.test(record?.producerNonce ?? "") &&
      Number.isSafeInteger(record?.createdMs) &&
      validQuestions(record?.questions) &&
      typeof record?.status === "string"
    ) {
      return record;
    }
  } catch {
    // A torn or foreign record is never surfaced to the UI.
  }
  return undefined;
}

function listRecords(
  sessionId: string,
): { file: string; record: QuestionRecord }[] {
  const directory = sessionDirectory(sessionId);
  if (!directory) return [];
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const file = path.join(directory, name);
        return { file, record: readRecord(file) };
      })
      .filter(
        (item): item is { file: string; record: QuestionRecord } =>
          Boolean(item.record) && item.record?.sessionId === sessionId,
      );
  } catch {
    return [];
  }
}

function replaceRecord(file: string, record: QuestionRecord): boolean {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // Windows ACLs are authoritative.
    }
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Best-effort cleanup only.
    }
    return false;
  }
}

function answerIdsMatch(
  questions: CukiiUserQuestionRequest["questions"],
  answers: Record<string, string>,
): boolean {
  const expected = questions.map((question) => question.id).sort();
  const actual = Object.keys(answers).sort();
  return (
    JSON.stringify(expected) === JSON.stringify(actual) &&
    Object.values(answers).every(
      (answer) =>
        typeof answer === "string" &&
        answer.trim().length > 0 &&
        Buffer.byteLength(answer.trim(), "utf8") <= 4096,
    )
  );
}

/** One run-scoped watcher and response authority for MCP user questions. */
export class BridgeQuestionBroker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, string>();
  private readonly notifiedMs = new Map<string, number>();
  private binding: CukiiRunBinding | undefined;

  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly onRequest: (request: CukiiUserQuestionRequest) => void,
    private readonly bindingReader: typeof readRunBindingForPid =
      readRunBindingForPid,
    private readonly onWithdraw?: (withdrawn: {
      runId: string;
      requestId: string;
      sessionId: string;
    }) => void,
  ) {}

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  bindVendorProcess(
    vendorPid: number,
    verifiedBinding?: CukiiRunBinding,
  ): boolean {
    const binding = verifiedBinding ?? this.bindingReader(vendorPid);
    if (
      !binding ||
      binding.vendorPid !== vendorPid ||
      binding.sessionId !== this.sessionId ||
      binding.runId !== this.runId
    ) {
      return false;
    }
    this.binding = binding;
    this.tick();
    return true;
  }

  tick(): void {
    if (!this.binding) return;
    const now = Date.now();
    const live = new Set<string>();
    for (const { record } of listRecords(this.sessionId)) {
      if (
        record.status !== "pending" ||
        record.runId !== this.runId ||
        record.producerNonce !== this.binding.nonce ||
        record.createdMs < this.binding.createdMs ||
        record.createdMs > now + 5_000 ||
        now - record.createdMs > 30 * 60_000
      )
        continue;
      live.add(record.id);
      const notified = this.notifiedMs.get(record.id);
      if (
        this.pending.has(record.id) &&
        notified !== undefined &&
        now - notified < RENOTIFY_INTERVAL_MS
      )
        continue;
      // Re-emitting is idempotent for the panel (keyed by run/request) and is
      // what restores the sheet after a webview reload or renderer crash.
      const fingerprint = questionFingerprint(record);
      this.pending.set(record.id, fingerprint);
      this.notifiedMs.set(record.id, now);
      this.onRequest({
        runId: this.runId,
        requestId: record.id,
        sessionId: this.sessionId,
        requestFingerprint: fingerprint,
        questions: record.questions,
      });
    }
    // A tracked request that is no longer pending on disk was finalized by
    // someone else (MCP timeout receipt, external cancel): drop the sheet so
    // the panel never shows a question whose agent already moved on.
    for (const id of [...this.pending.keys()]) {
      if (live.has(id)) continue;
      this.pending.delete(id);
      this.notifiedMs.delete(id);
      this.onWithdraw?.({ runId: this.runId, requestId: id, sessionId: this.sessionId });
    }
  }

  respond(response: CukiiUserQuestionResponse): boolean {
    if (
      !this.binding ||
      response.runId !== this.runId ||
      response.sessionId !== this.sessionId ||
      this.pending.get(response.requestId) !== response.requestFingerprint
    ) {
      return false;
    }
    const item = listRecords(this.sessionId).find(
      ({ record }) => record.id === response.requestId,
    );
    if (
      !item ||
      item.record.status !== "pending" ||
      item.record.runId !== this.runId ||
      item.record.producerNonce !== this.binding.nonce
    )
      return false;
    if (questionFingerprint(item.record) !== response.requestFingerprint) {
      return false;
    }
    const next: QuestionRecord = response.cancelled
      ? { ...item.record, status: "cancelled", reason: "user cancelled" }
      : response.answers &&
          answerIdsMatch(item.record.questions, response.answers)
        ? {
            ...item.record,
            status: "answered",
            answers: Object.fromEntries(
              Object.entries(response.answers).map(([id, answer]) => [
                id,
                answer.trim(),
              ]),
            ),
          }
        : item.record;
    if (next === item.record || !replaceRecord(item.file, next)) return false;
    this.pending.delete(response.requestId);
    this.notifiedMs.delete(response.requestId);
    return true;
  }

  dispose(reason = "run stopped"): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const { file, record } of listRecords(this.sessionId)) {
      if (
        record.status === "pending" &&
        record.runId === this.runId &&
        record.producerNonce === this.binding?.nonce
      ) {
        replaceRecord(file, { ...record, status: "cancelled", reason });
      }
    }
    this.pending.clear();
    this.notifiedMs.clear();
  }
}
