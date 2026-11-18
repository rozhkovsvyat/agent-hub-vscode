/**
 * Standalone stdio MCP proxy used by every native vendor CLI.
 *
 * The real Cukii Box bearer token never enters vendor config files. The
 * extension host keeps it in VS Code SecretStorage and exposes a short-lived
 * loopback relay guarded by an activation-scoped capability. Vendor configs
 * contain only that local capability and are refreshed on every activation.
 */
import http from "node:http";
import https from "node:https";
import readline from "node:readline";

const MAX_LINE_BYTES = 2 * 1024 * 1024;

function errorEnvelope(id: unknown, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code: -32000, message },
  });
}

type RelayTarget = { personal: URL; work?: URL; token: string };

function endpoint(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(
      "Cukii memory endpoint must use HTTPS (HTTP is allowed only on loopback)",
    );
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Cukii memory endpoint contains forbidden URL credentials");
  }
  return url;
}

function relayTarget(): RelayTarget {
  const rawUrl = (process.env.CUKII_MEMORY_RELAY_URL ?? "").trim();
  const rawWorkUrl = (process.env.CUKII_MEMORY_WORK_RELAY_URL ?? "").trim();
  const token = (process.env.CUKII_MEMORY_RELAY_TOKEN ?? "").trim();
  if (token.length < 32 || token.length > 4096) {
    throw new Error("Cukii memory relay capability is unavailable");
  }
  if (!rawUrl) throw new Error("Cukii memory endpoint is unavailable");
  return {
    personal: endpoint(rawUrl),
    work: rawWorkUrl ? endpoint(rawWorkUrl) : undefined,
    token,
  };
}

type RpcRequest = {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: Record<string, unknown> };
};

async function post(url: URL, token: string, body: Buffer): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const request = url.protocol === "https:" ? https.request : http.request;
    const outgoing = request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        timeout: 125_000,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_LINE_BYTES) {
            outgoing.destroy(new Error("MCP response exceeds the proxy limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              new Error(
                `Cukii memory relay returned HTTP ${response.statusCode}`,
              ),
            );
            return;
          }
          resolve(text);
        });
      },
    );
    outgoing.on("timeout", () =>
      outgoing.destroy(new Error("Cukii memory relay timed out")),
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function bankFromCall(request: RpcRequest): "personal" | "work" | "both" {
  const args = request.params?.arguments ?? {};
  if (args.bank_id === "work") return "work";
  if (args.bank_id === "personal") return "personal";
  const ids = Array.isArray(args.bank_ids)
    ? args.bank_ids.filter((id): id is string => typeof id === "string")
    : [];
  if (ids.includes("work") && ids.includes("personal")) return "both";
  if (ids.includes("work")) return "work";
  return "personal";
}

function withSingleBank(request: RpcRequest, bank: "personal" | "work") {
  const params = request.params ?? {};
  const args = { ...(params.arguments ?? {}) };
  delete args.bank_ids;
  delete args.merge;
  args.bank_id = bank;
  return { ...request, params: { ...params, arguments: args } };
}

function textResult(body: any): any {
  const text = body?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : undefined;
}

function federateSearch(id: unknown, left: any, right: any): string {
  const l = textResult(left);
  const r = textResult(right);
  if (!l || !r)
    return errorEnvelope(id, "Cukii Box returned an invalid search response");
  const merged = {
    ...l,
    bank_ids: ["personal", "work"],
    complete: Boolean(l.complete && r.complete),
    incomplete_sources: [
      ...(l.incomplete_sources ?? []),
      ...(r.incomplete_sources ?? []),
    ],
    results: [...(l.results ?? []), ...(r.results ?? [])],
    sources: [...(l.sources ?? []), ...(r.sources ?? [])],
    total: (l.total ?? 0) + (r.total ?? 0),
    merge: "federated_rrf",
  };
  merged.results.sort(
    (a: any, b: any) =>
      Number(a.rank_in_source ?? Number.MAX_SAFE_INTEGER) -
        Number(b.rank_in_source ?? Number.MAX_SAFE_INTEGER) ||
      String(a.bank_id).localeCompare(String(b.bank_id)),
  );
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify(merged) }],
      isError: false,
    },
  });
}

async function forward(line: string): Promise<string | undefined> {
  let id: unknown = null;
  try {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw new Error("MCP request exceeds the Cukii memory proxy limit");
    }
    const request = JSON.parse(line) as RpcRequest;
    id = request?.id;
    const target = relayTarget();
    const body = Buffer.from(line, "utf8");
    if (
      request.method !== "tools/call" ||
      request.params?.name === "agent_banks"
    ) {
      if (request.params?.name === "agent_banks" && target.work) {
        const [personal, work] = await Promise.all([
          post(target.personal, target.token, body),
          post(target.work, target.token, body),
        ]);
        const left = JSON.parse(personal);
        const right = JSON.parse(work);
        const banks = [
          ...(textResult(left)?.banks ?? []),
          ...(textResult(right)?.banks ?? []),
        ];
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ schema_version: 1, banks }),
              },
            ],
            isError: false,
          },
        });
      }
      return (await post(target.personal, target.token, body)) || undefined;
    }
    const bank = bankFromCall(request);
    if (bank === "both") {
      if (request.params?.name !== "agent_search" || !target.work) {
        throw new Error(
          "Both memory banks require agent_search and a work endpoint",
        );
      }
      const [personal, work] = await Promise.all([
        post(
          target.personal,
          target.token,
          Buffer.from(JSON.stringify(withSingleBank(request, "personal"))),
        ),
        post(
          target.work,
          target.token,
          Buffer.from(JSON.stringify(withSingleBank(request, "work"))),
        ),
      ]);
      return federateSearch(id, JSON.parse(personal), JSON.parse(work));
    }
    const endpoint = bank === "work" ? target.work : target.personal;
    if (!endpoint) throw new Error("Cukii work memory endpoint is unavailable");
    return (await post(endpoint, target.token, body)) || undefined;
  } catch (error) {
    return errorEnvelope(
      id,
      error instanceof Error ? error.message : "Cukii memory relay failed",
    );
  }
}

const input = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
let queue = Promise.resolve();
input.on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    const response = await forward(line);
    if (response) process.stdout.write(`${response}\n`);
  });
});
