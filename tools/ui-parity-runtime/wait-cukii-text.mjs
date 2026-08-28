import { CdpClient, listTargets } from "./cdp-client.mjs";

const [targetId, pattern, timeoutText] = process.argv.slice(2);
const timeoutMs = Number(timeoutText ?? 55000);
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
if (!targetId || !pattern)
  throw new Error("usage: wait-cukii-text.mjs <targetId> <pattern> [timeoutMs]");
const target = (await listTargets(endpoint)).find(
  (candidate) => candidate.id === targetId,
);
if (!target) throw new Error(`Target ${targetId} is missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const deadline = Date.now() + Math.min(timeoutMs, 55000);
  let body = "";
  while (Date.now() < deadline) {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(document.querySelector("#active-frame")?.contentDocument ?? document).body?.innerText ?? ""`,
    });
    body = response.result.value ?? "";
    if (body.includes(pattern)) {
      process.stdout.write(
        `${JSON.stringify({ status: "FOUND", pattern, excerpt: body.slice(Math.max(0, body.indexOf(pattern) - 300), body.indexOf(pattern) + pattern.length + 700) })}\n`,
      );
      process.exitCode = 0;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!body.includes(pattern)) {
    process.stdout.write(
      `${JSON.stringify({ status: "TIMEOUT", pattern, tail: body.slice(-1500) })}\n`,
    );
    process.exitCode = 2;
  }
} finally {
  client.close();
}
