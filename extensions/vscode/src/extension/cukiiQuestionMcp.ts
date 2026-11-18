import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  processLineage,
  resolveRunBindingFromLineage,
  type CukiiRunBinding,
} from "@cukii/vendor-bridge";
import { resolveWithBoundedRetry } from "./bindingRetry";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const MIN_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 2 * 60 * 60_000;
const POLL_INTERVAL_MS = 100;
const INBOX_LEASE_MS = 24 * 60 * 60_000;
const INBOX_LOCK_STALE_MS = 30_000;
const INBOX_READER_ID = `mcp-js-${process.pid}-${randomUUID().replace(/-/g, "")}`;

export const CUKII_REACTION_EMOJIS = [
  "❤️",
  "😂",
  "👍",
  "🔥",
  "👏",
  "😮",
  "😢",
  "🤝",
] as const;
type CukiiReactionEmoji = (typeof CUKII_REACTION_EMOJIS)[number];

type Question = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
};

type InboxRecord = {
  id: string;
  sessionId: string;
  text: string;
  createdMs: number;
  status: "pending" | "read";
  from?: string;
  leaseOwner?: string;
  leasePid?: number;
  leaseProcessStartToken?: string;
  leaseUntilMs?: number;
  hookOfferedAtMs?: number;
  hookOfferedCount?: number;
  readAt?: string;
};

let cachedBinding: CukiiRunBinding | undefined;

async function toolBinding(): Promise<CukiiRunBinding | undefined> {
  if (cachedBinding) return cachedBinding;
  const lineage = processLineage(process.ppid);
  cachedBinding = await resolveWithBoundedRetry(() =>
    resolveRunBindingFromLineage(lineage),
  );
  return cachedBinding;
}

/**
 * How long one tools/call waits for the user. By default it has no wall-clock
 * expiry: the user asked for a question, so only an answer, explicit cancel,
 * session replacement, or vendor disconnect may retire it. Operators can set
 * CUKII_QUESTION_TIMEOUT_MS for a bounded unattended environment.
 */
export function waitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  if (env.CUKII_QUESTION_TIMEOUT_MS === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const raw = Number(env.CUKII_QUESTION_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return Number.POSITIVE_INFINITY;
  return Math.min(
    Math.max(Math.floor(raw), MIN_WAIT_TIMEOUT_MS),
    MAX_WAIT_TIMEOUT_MS,
  );
}

function bounded(value: unknown, bytes: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value.trim(), "utf8") <= bytes
  );
}

function normalizeQuestions(value: unknown): Question[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new Error("request_user_input requires 1 to 3 questions");
  }
  const ids = new Set<string>();
  return value.map((raw) => {
    if (typeof raw !== "object" || raw === null)
      throw new Error("invalid question");
    const item = raw as Record<string, unknown>;
    if (
      !bounded(item.id, 128) ||
      !SAFE_SEGMENT.test(item.id.trim()) ||
      ids.has(item.id.trim()) ||
      !bounded(item.header, 80) ||
      !bounded(item.question, 4096) ||
      !Array.isArray(item.options) ||
      item.options.length < 2 ||
      item.options.length > 3
    ) {
      throw new Error("invalid question contract");
    }
    ids.add(item.id.trim());
    const labels = new Set<string>();
    const options = item.options.map((rawOption) => {
      if (typeof rawOption !== "object" || rawOption === null)
        throw new Error("invalid question option");
      const option = rawOption as Record<string, unknown>;
      if (
        !bounded(option.label, 80) ||
        labels.has(option.label.trim()) ||
        !bounded(option.description, 1024)
      ) {
        throw new Error("invalid question option");
      }
      labels.add(option.label.trim());
      return {
        label: option.label.trim(),
        description: option.description.trim(),
      };
    });
    return {
      id: item.id.trim(),
      header: item.header.trim(),
      question: item.question.trim(),
      options,
    };
  });
}

function questionsRoot(): string {
  return (
    process.env.CUKII_QUESTIONS_DIR ||
    path.join(
      process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".cukii"),
      "cukii-questions",
    )
  );
}

function inboxRoot(): string {
  return (
    process.env.CUKII_INBOX_DIR ||
    path.join(
      process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".cukii"),
      "cukii-inbox",
    )
  );
}

function inboxSessionDir(sessionId: string): string | undefined {
  return SAFE_SEGMENT.test(sessionId)
    ? path.join(inboxRoot(), sessionId)
    : undefined;
}

function readInboxRecords(
  sessionId: string,
): { file: string; record: InboxRecord }[] {
  const directory = inboxSessionDir(sessionId);
  if (!directory) return [];
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => {
        const file = path.join(directory, name);
        try {
          const record = JSON.parse(
            fs.readFileSync(file, "utf8"),
          ) as InboxRecord;
          if (
            SAFE_SEGMENT.test(record?.id ?? "") &&
            record?.sessionId === sessionId &&
            typeof record?.text === "string" &&
            Number.isSafeInteger(record?.createdMs) &&
            (record?.status === "pending" || record?.status === "read")
          ) {
            return { file, record };
          }
        } catch {
          // Torn or foreign record: the normal turn-end drain remains safe.
        }
        return undefined;
      })
      .filter((item): item is { file: string; record: InboxRecord } =>
        Boolean(item),
      )
      .sort((left, right) => left.record.createdMs - right.record.createdMs);
  } catch {
    return [];
  }
}

function replaceInboxRecord(file: string, record: InboxRecord): boolean {
  return replaceRecord(file, JSON.stringify(record));
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
    0,
    0,
    milliseconds,
  );
}

function withInboxLock<T>(sessionId: string, action: () => T): T {
  const directory = inboxSessionDir(sessionId);
  if (!directory) throw new Error("invalid Cukii inbox session");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".claim-lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > INBOX_LOCK_STALE_MS) {
          fs.rmdirSync(lock);
          continue;
        }
      } catch {
        // The owner may have released or reclaimed it between calls.
      }
      sleepSync(10);
    }
  }
  if (!acquired) throw new Error("Cukii inbox claim lock is busy");
  try {
    return action();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      // A crashed/reclaimed lock must not cause a second failure.
    }
  }
}

function liveLease(record: InboxRecord, now: number): boolean {
  if (
    !Number.isSafeInteger(record.leasePid) ||
    (record.leasePid ?? 0) <= 0 ||
    !record.leaseProcessStartToken ||
    (record.leaseUntilMs ?? 0) <= now
  ) {
    return false;
  }
  const snapshot = processLineage(record.leasePid as number)[0];
  return snapshot?.startToken === record.leaseProcessStartToken;
}

function ownProcessStartToken(): string | undefined {
  return processLineage(process.pid)[0]?.startToken;
}

async function brokerInbox(argumentsValue: unknown) {
  const binding = await toolBinding();
  if (!binding) {
    return {
      messages: [],
      batchSize: 0,
      note: "Cukii run binding unavailable; live inbox is unavailable",
    };
  }
  const replayOutstanding =
    (argumentsValue as { replayOutstanding?: unknown } | undefined)
      ?.replayOutstanding === true;
  const startToken = ownProcessStartToken();
  if (!startToken) throw new Error("Cukii MCP reader identity unavailable");
  const claimed = withInboxLock(binding.sessionId, () => {
    const now = Date.now();
    const result: InboxRecord[] = [];
    for (const { file, record } of readInboxRecords(binding.sessionId)) {
      if (record.status !== "pending") continue;
      const leased = liveLease(record, now);
      const owned = leased && record.leaseOwner === INBOX_READER_ID;
      if (owned) {
        if (replayOutstanding) result.push(record);
        continue;
      }
      if (leased) continue;
      if (record.hookOfferedAtMs !== undefined && !replayOutstanding) continue;
      const updated: InboxRecord = {
        ...record,
        leaseOwner: INBOX_READER_ID,
        leasePid: process.pid,
        leaseProcessStartToken: startToken,
        leaseUntilMs: now + INBOX_LEASE_MS,
      };
      delete updated.hookOfferedAtMs;
      delete updated.hookOfferedCount;
      if (replaceInboxRecord(file, updated)) result.push(updated);
    }
    return result;
  });
  const outstandingMessageIds = readInboxRecords(binding.sessionId)
    .filter(
      ({ record }) =>
        record.status === "pending" &&
        record.leaseOwner === INBOX_READER_ID &&
        liveLease(record, Date.now()),
    )
    .map(({ record }) => record.id);
  const messages = claimed.map((record) => ({
    text: record.text,
    messageId: record.id,
    sentAtMs: record.createdMs,
    from: record.from || "user",
  }));
  return {
    messages,
    batchSize: messages.length,
    ackRequired: outstandingMessageIds.length > 0,
    outstandingMessageIds,
    replayedOutstanding: replayOutstanding,
    ...(!messages.length && outstandingMessageIds.length
      ? {
          note: "Earlier text is not repeated; acknowledge outstandingMessageIds after processing.",
        }
      : {}),
  };
}

async function brokerInboxAck(argumentsValue: unknown) {
  const binding = await toolBinding();
  if (!binding) {
    return { acked: [], ackedCount: 0, note: "Cukii run binding unavailable" };
  }
  const rawIds = (argumentsValue as { messageIds?: unknown } | undefined)
    ?.messageIds;
  if (
    !Array.isArray(rawIds) ||
    rawIds.length < 1 ||
    rawIds.length > 256 ||
    rawIds.some((id) => typeof id !== "string" || !SAFE_SEGMENT.test(id))
  ) {
    throw new Error("broker_inbox_ack requires valid messageIds");
  }
  const wanted = new Set(rawIds as string[]);
  const acked = withInboxLock(binding.sessionId, () => {
    const result: string[] = [];
    for (const { file, record } of readInboxRecords(binding.sessionId)) {
      if (record.status !== "pending" || !wanted.has(record.id)) continue;
      const offeredByHook = record.hookOfferedAtMs !== undefined;
      if (
        record.leaseOwner !== INBOX_READER_ID &&
        !(record.leaseOwner === undefined && offeredByHook)
      ) {
        continue;
      }
      const updated: InboxRecord = {
        ...record,
        status: "read",
        readAt: new Date().toISOString(),
      };
      delete updated.leaseOwner;
      delete updated.leasePid;
      delete updated.leaseProcessStartToken;
      delete updated.leaseUntilMs;
      delete updated.hookOfferedAtMs;
      delete updated.hookOfferedCount;
      if (replaceInboxRecord(file, updated)) result.push(record.id);
    }
    return result;
  });
  return { acked, ackedCount: acked.length };
}

export function reactionsRoot(): string {
  return (
    process.env.CUKII_REACTIONS_DIR ||
    path.join(
      process.env.CONTINUE_GLOBAL_DIR || path.join(os.homedir(), ".cukii"),
      "cukii-reactions",
    )
  );
}

function writeExclusive(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows ACLs are authoritative.
  }
}

/** Atomic rewrite mirroring the extension-side writer: tmp + rename. */
function replaceRecord(file: string, body: string): boolean {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, body, {
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

/**
 * Converge a wait that ended without an answer: the record stops being
 * pending, so the broker withdraws the panel sheet and a late click is
 * rejected instead of writing an answer nobody will ever read.
 */
export function finalizeCancelled(
  file: string,
  requestId: string,
  reason: string,
): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (record?.id !== requestId || record?.status !== "pending") return false;
    return replaceRecord(
      file,
      JSON.stringify({ ...record, status: "cancelled", reason }),
    );
  } catch {
    return false;
  }
}

export async function waitForAnswer(
  file: string,
  requestId: string,
  deps: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<Record<string, unknown>> {
  const timeoutMs = deps.timeoutMs ?? waitTimeoutMs();
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Number.isFinite(timeoutMs)
    ? now() + timeoutMs
    : Number.POSITIVE_INFINITY;
  while (now() < deadline) {
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      if (record.status === "answered" || record.status === "cancelled")
        return record;
    } catch {
      // Atomic writer may be between rename boundaries; retry.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  finalizeCancelled(file, requestId, "timeout");
  return { status: "cancelled", reason: "timeout" };
}

/** requestId → record file for every tools/call still waiting on the user. */
export const outstandingRequests = new Map<string, string>();

/** JSON-RPC id of the tools/call → its question requestId. */
export const rpcQuestionRequests = new Map<string, string>();

/**
 * The client abandoned one call (`notifications/cancelled`, e.g. Qwen's idle
 * timeout). Retire exactly that question, or its sheet stays on screen and
 * the user answers a call nobody waits for (2.0.157 acceptance).
 */
export function cancelQuestionForRpc(rpcId: unknown, reason: string): boolean {
  const requestId = rpcQuestionRequests.get(String(rpcId));
  if (!requestId) return false;
  const file = outstandingRequests.get(requestId);
  return file ? finalizeCancelled(file, requestId, reason) : false;
}

/**
 * The vendor went away (stdin closed). Converge every outstanding wait so no
 * panel sheet or broker slot hangs behind a dead agent.
 */
export function dropOutstandingRequests(reason: string): void {
  for (const [requestId, file] of outstandingRequests) {
    finalizeCancelled(file, requestId, reason);
  }
  outstandingRequests.clear();
}

async function requestUserInput(argumentsValue: unknown, rpcId?: unknown) {
  // The vendor can launch its MCP child a few milliseconds before the host's
  // post-spawn CIM/proc lookup publishes the run binding. Treat that as a
  // bounded startup race, not a terminal user-question failure.
  // Capturing Windows ancestry can involve WMI, so do it once. The bounded
  // retry then polls only owner files while the Extension Host publishes the
  // binding; one slow OS snapshot cannot multiply into minutes of blocking.
  const binding = await toolBinding();
  if (!binding)
    return { cancelled: true, reason: "Cukii run binding unavailable" };
  const questions = normalizeQuestions(
    (argumentsValue as { questions?: unknown } | undefined)?.questions,
  );
  const requestId = `question-${randomUUID().replace(/-/g, "")}`;
  const record = {
    id: requestId,
    sessionId: binding.sessionId,
    runId: binding.runId,
    producerNonce: binding.nonce,
    createdMs: Date.now(),
    status: "pending",
    questions,
  };
  const file = path.join(
    questionsRoot(),
    binding.sessionId,
    `${requestId}.json`,
  );
  writeExclusive(file, JSON.stringify(record));
  outstandingRequests.set(requestId, file);
  if (rpcId !== undefined) rpcQuestionRequests.set(String(rpcId), requestId);
  try {
    const response = await waitForAnswer(file, requestId);
    return response.status === "answered"
      ? { requestId, answers: response.answers || {} }
      : {
          requestId,
          cancelled: true,
          reason: response.reason || "cancelled",
        };
  } finally {
    outstandingRequests.delete(requestId);
    if (rpcId !== undefined) rpcQuestionRequests.delete(String(rpcId));
  }
}

function normalizeReactionEmoji(argumentsValue: unknown): CukiiReactionEmoji {
  const emoji = (argumentsValue as { emoji?: unknown } | undefined)?.emoji;
  if (
    typeof emoji !== "string" ||
    !CUKII_REACTION_EMOJIS.includes(emoji as CukiiReactionEmoji)
  ) {
    throw new Error("unsupported reaction emoji");
  }
  return emoji as CukiiReactionEmoji;
}

/**
 * Publish a run-bound, one-way reaction request. The Extension Host validates
 * the producer nonce again before it can reach a panel; the MCP receipt only
 * means the request was durably queued, not that a stale/forged record won.
 */
async function reactToUserMessage(argumentsValue: unknown) {
  const binding = await toolBinding();
  if (!binding) {
    return { reacted: false, reason: "Cukii run binding unavailable" };
  }
  const emoji = normalizeReactionEmoji(argumentsValue);
  const reactionId = `reaction-${randomUUID().replace(/-/g, "")}`;
  const record = {
    id: reactionId,
    sessionId: binding.sessionId,
    runId: binding.runId,
    producerNonce: binding.nonce,
    createdMs: Date.now(),
    status: "pending",
    emoji,
  };
  writeExclusive(
    path.join(reactionsRoot(), binding.sessionId, `${reactionId}.json`),
    JSON.stringify(record),
  );
  return { reacted: true, reactionId, emoji };
}

const QUESTION_TOOL = {
  name: "request_user_input",
  description:
    "Show one shared Cukii dialog with 1-3 short questions and wait for the correlated answer.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
            header: { type: "string", minLength: 1, maxLength: 80 },
            question: { type: "string", minLength: 1, maxLength: 4096 },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", minLength: 1, maxLength: 80 },
                  description: {
                    type: "string",
                    minLength: 1,
                    maxLength: 1024,
                  },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
          },
          required: ["id", "header", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

const REACTION_TOOL = {
  name: "react_to_user_message",
  description:
    "Optionally add one human-style emoji reaction to the latest user message. Default to no reaction; call only for a clear social signal such as genuine amusement, warmth, celebration, empathy, surprise, or strong approval. Never call for routine instructions, ordinary technical questions, status checks, or merely because this tool is available.",
  inputSchema: {
    type: "object",
    properties: {
      emoji: {
        type: "string",
        enum: [...CUKII_REACTION_EMOJIS],
        description: "The single reaction that best matches the whole context.",
      },
    },
    required: ["emoji"],
    additionalProperties: false,
  },
};

const BROKER_INBOX_TOOL = {
  name: "broker_inbox",
  description:
    "Return one FIFO batch containing every newly offered live user follow-up for this Cukii session. Text already returned to this live reader is not repeated unless replayOutstanding is true; acknowledge processed IDs with broker_inbox_ack.",
  inputSchema: {
    type: "object",
    properties: { replayOutstanding: { type: "boolean", default: false } },
    additionalProperties: false,
  },
};

const BROKER_INBOX_ACK_TOOL = {
  name: "broker_inbox_ack",
  description:
    "Acknowledge exact Cukii follow-up message IDs only after their whole delivered batch has been processed.",
  inputSchema: {
    type: "object",
    properties: {
      messageIds: {
        type: "array",
        minItems: 1,
        maxItems: 256,
        items: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
      },
    },
    required: ["messageIds"],
    additionalProperties: false,
  },
};

/**
 * How often a waiting request_user_input reports progress. MCP clients abort
 * tool calls that stay silent: Qwen Code's `mcp.toolIdleTimeoutMs` (300s by
 * default, 1h at most) ignores the per-server `timeout` and is reset only by a
 * response or a progress notification (card 20933fd6, live run: three
 * questions aborted at exactly 300 000 ms while the owner was still deciding).
 */
export const QUESTION_PROGRESS_INTERVAL_MS = 30_000;

export type QuestionProgressHeartbeat = {
  notify: (frame: Record<string, unknown>) => void;
  intervalMs: number;
};

/** Progress notifications while the human thinks; off without a token. */
function startQuestionProgress(
  params: Record<string, unknown>,
  heartbeat: QuestionProgressHeartbeat,
): () => void {
  const meta = params._meta as Record<string, unknown> | undefined;
  const token = meta?.progressToken;
  if (typeof token !== "string" && typeof token !== "number") {
    return () => undefined;
  }
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    heartbeat.notify({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress,
        message: "Waiting for the user's answer",
      },
    });
  }, heartbeat.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function mcpResponseForMessage(
  message: unknown,
  callQuestionTool: (
    argumentsValue: unknown,
    rpcId?: unknown,
  ) => Promise<unknown> = requestUserInput,
  callReactionTool: (
    argumentsValue: unknown,
  ) => Promise<unknown> = reactToUserMessage,
  callInboxTool: (argumentsValue: unknown) => Promise<unknown> = brokerInbox,
  callInboxAckTool: (
    argumentsValue: unknown,
  ) => Promise<unknown> = brokerInboxAck,
  questionHeartbeat: QuestionProgressHeartbeat = {
    notify: send,
    intervalMs: QUESTION_PROGRESS_INTERVAL_MS,
  },
): Promise<Record<string, unknown> | undefined> {
  if (typeof message !== "object" || message === null) return undefined;
  const frame = message as Record<string, unknown>;
  const id = frame.id;
  const method = frame.method;
  const params = (frame.params || {}) as Record<string, unknown>;
  if (method === "notifications/cancelled") {
    cancelQuestionForRpc(params.requestId, "client cancelled the call");
    return undefined;
  }
  if (method === "notifications/initialized") return undefined;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          (params.protocolVersion as string | undefined) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cukii-question", version: "1.0.0" },
      },
    };
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          QUESTION_TOOL,
          REACTION_TOOL,
          BROKER_INBOX_TOOL,
          BROKER_INBOX_ACK_TOOL,
        ],
      },
    };
  }
  if (method === "tools/call" && params.name === "request_user_input") {
    const stopProgress = startQuestionProgress(params, questionHeartbeat);
    try {
      const result = await callQuestionTool(params.arguments, id);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      };
    } catch {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Cukii question request rejected" }],
          isError: true,
        },
      };
    } finally {
      stopProgress();
    }
  }
  if (method === "tools/call" && params.name === "react_to_user_message") {
    try {
      const result = await callReactionTool(params.arguments);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      };
    } catch {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Cukii reaction request rejected" }],
          isError: true,
        },
      };
    }
  }
  if (method === "tools/call" && params.name === "broker_inbox") {
    try {
      const result = await callInboxTool(params.arguments);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      };
    } catch {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Cukii inbox request rejected" }],
          isError: true,
        },
      };
    }
  }
  if (method === "tools/call" && params.name === "broker_inbox_ack") {
    try {
      const result = await callInboxAckTool(params.arguments);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      };
    } catch {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: "Cukii inbox acknowledgement rejected" },
          ],
          isError: true,
        },
      };
    }
  }
  if (id !== undefined) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method ${String(method)}` },
    };
  }
  return undefined;
}

function send(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

export function startMcpStdio(): void {
  const input = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  input.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    void mcpResponseForMessage(message).then((frame) => {
      if (frame) send(frame);
    });
  });
  input.on("close", () => {
    // The vendor side of stdio is gone; nothing will consume a late answer.
    dropOutstandingRequests("vendor disconnected");
    process.exit(0);
  });
}

if (require.main === module) startMcpStdio();
