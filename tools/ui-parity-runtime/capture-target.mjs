import { writeFile } from "node:fs/promises";
import { CdpClient, listTargets } from "./cdp-client.mjs";

const [targetId, output] = process.argv.slice(2);
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
if (!targetId || !output)
  throw new Error("usage: capture-target.mjs <targetId> <output.png>");
const target = (await listTargets(endpoint)).find(
  (candidate) => candidate.id === targetId,
);
if (!target) throw new Error(`Target ${targetId} is missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  await client.send("Page.enable");
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await writeFile(output, Buffer.from(result.data, "base64"));
  process.stdout.write(`${JSON.stringify({ targetId, output })}\n`);
} finally {
  client.close();
}
