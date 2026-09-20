import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  processLineage,
  resolveRunBindingFromLineage,
} from "./bridgeRunBinding";
import { resolveWithBoundedRetry } from "./bindingRetry";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60_000;
const MIN_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 2 * 60 * 60_000;
const POLL_INTERVAL_MS = 100;

type Question = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
};

/**
 * How long one tools/call waits for the user. Bounded so an agent never
 * hangs forever on a dead panel, long enough that a human can read and
 * answer; CUKII_QUESTION_TIMEOUT_MS tunes it within sane clamps.
 */
export function waitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CUKII_QUESTION_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_WAIT_TIMEOUT_MS;
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
    if (typeof raw !== "object" || raw === null) throw new Error("invalid question");
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
    path.join(os.homedir(), ".continue", "cukii-questions")
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
  const deadline = now() + timeoutMs;
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

async function requestUserInput(argumentsValue: unknown) {
  // The vendor can launch its MCP child a few milliseconds before the host's
  // post-spawn CIM/proc lookup publishes the run binding. Treat that as a
  // bounded startup race, not a terminal user-question failure.
  // Capturing Windows ancestry can involve WMI, so do it once. The bounded
  // retry then polls only owner files while the Extension Host publishes the
  // binding; one slow OS snapshot cannot multiply into minutes of blocking.
  const lineage = processLineage(process.ppid);
  const binding = await resolveWithBoundedRetry(() =>
    resolveRunBindingFromLineage(lineage),
  );
  if (!binding) return { cancelled: true, reason: "Cukii run binding unavailable" };
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
  }
}

const TOOL = {
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
                  description: { type: "string", minLength: 1, maxLength: 1024 },
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

export async function mcpResponseForMessage(
  message: unknown,
  callTool: (argumentsValue: unknown) => Promise<unknown> = requestUserInput,
): Promise<Record<string, unknown> | undefined> {
  if (typeof message !== "object" || message === null) return undefined;
  const frame = message as Record<string, unknown>;
  const id = frame.id;
  const method = frame.method;
  const params = (frame.params || {}) as Record<string, unknown>;
  if (method === "notifications/initialized" || method === "notifications/cancelled")
    return undefined;
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
    return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
  }
  if (method === "tools/call" && params.name === "request_user_input") {
    try {
      const result = await callTool(params.arguments);
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
