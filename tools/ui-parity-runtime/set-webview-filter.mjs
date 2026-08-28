import { CdpClient, listTargets } from "./cdp-client.mjs";

const extensionId = process.argv[2];
const value = process.argv.slice(3).join(" ");
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
if (!extensionId)
  throw new Error("Usage: set-webview-filter.mjs <extension id> <value>");
const target = (await listTargets(endpoint)).find(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`) &&
    !candidate.url.includes("purpose=webviewView"),
);
if (!target) throw new Error(`${extensionId}: editor target missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      const input = [...(doc?.querySelectorAll("input") ?? [])].find((element) =>
        element.placeholder?.includes("Filter actions"),
      );
      if (!input) return "MISSING";
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return input.value;
    })()`,
  });
  process.stdout.write(`${JSON.stringify({ status: result.result.value })}\n`);
} finally {
  client.close();
}
