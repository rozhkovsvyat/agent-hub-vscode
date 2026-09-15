/**
 * Standalone stdio MCP proxy used by every native vendor CLI.
 *
 * The real Cukii Box bearer token never enters vendor config files. The
 * extension host keeps it in VS Code SecretStorage and exposes a short-lived
 * loopback relay guarded by an activation-scoped capability. Vendor configs
 * contain only that local capability and are refreshed on every activation.
 */
import http from "node:http";
import readline from "node:readline";

const MAX_LINE_BYTES = 2 * 1024 * 1024;

function errorEnvelope(id: unknown, message: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: { code: -32000, message },
  });
}

function relayTarget(): { url: URL; token: string } {
  const rawUrl = (process.env.CUKII_MEMORY_RELAY_URL ?? "").trim();
  const token = (process.env.CUKII_MEMORY_RELAY_TOKEN ?? "").trim();
  const url = new URL(rawUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)
  ) {
    throw new Error("Cukii memory relay must be a loopback HTTP endpoint");
  }
  if (token.length < 32 || token.length > 256) {
    throw new Error("Cukii memory relay capability is unavailable");
  }
  return { url, token };
}

async function forward(line: string): Promise<string | undefined> {
  let id: unknown = null;
  try {
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      throw new Error("MCP request exceeds the Cukii memory proxy limit");
    }
    const request = JSON.parse(line) as { id?: unknown };
    id = request?.id;
    const { url, token } = relayTarget();
    const body = Buffer.from(line, "utf8");
    return await new Promise<string | undefined>((resolve, reject) => {
      const outgoing = http.request(
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
              outgoing.destroy(
                new Error("MCP response exceeds the proxy limit"),
              );
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
            resolve(text || undefined);
          });
        },
      );
      outgoing.on("timeout", () =>
        outgoing.destroy(new Error("Cukii memory relay timed out")),
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
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
