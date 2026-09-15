import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { resolveAncestorRunBinding } from "./bridgeRunBinding";
import { resolveWithBoundedRetry } from "./bindingRetry";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const WAIT_TIMEOUT_MS = 30 * 60_000;

type Question = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[];
};

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

async function waitForAnswer(file: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { status: "cancelled", reason: "timeout" };
}

async function requestUserInput(argumentsValue: unknown) {
  // The vendor can launch its MCP child a few milliseconds before the host's
  // post-spawn CIM/proc lookup publishes the run binding. Treat that as a
  // bounded startup race, not a terminal user-question failure.
  const binding = await resolveWithBoundedRetry(resolveAncestorRunBinding);
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
  const response = await waitForAnswer(file);
  return response.status === "answered"
    ? { requestId, answers: response.answers || {} }
    : {
        requestId,
        cancelled: true,
        reason: response.reason || "cancelled",
      };
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

function send(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const id = message.id;
  const method = message.method;
  const params = (message.params || {}) as Record<string, unknown>;
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          (params.protocolVersion as string | undefined) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cukii-question", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    return;
  }
  if (method === "tools/call" && params.name === "request_user_input") {
    try {
      const result = await requestUserInput(params.arguments);
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result) }],
          isError: false,
        },
      });
    } catch {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Cukii question request rejected" }],
          isError: true,
        },
      });
    }
    return;
  }
  if (id !== undefined) {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method ${String(method)}` },
    });
  }
});
