import { CdpClient, listTargets } from "./cdp-client.mjs";
import { readFileSync } from "node:fs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const targets = (await listTargets(endpoint)).filter((target) => {
  if (target.type !== "iframe") return false;
  return new URL(target.url).searchParams.get("extensionId") === "cukii.cukii-vscode";
});

const evidence = [];
for (const target of targets) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  const result = await client.send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const frame = document.querySelector("#active-frame");
      const doc = frame?.contentDocument;
      const bodyText = doc?.body?.innerText ?? "";
      return {
        bodyText: bodyText.slice(0, 300),
        hasReadyToCode: bodyText.includes("Ready to code?"),
        hasOldEmptyState: bodyText.includes("Chat, Plan, Agent"),
        hasSearchSessions: Boolean(doc?.querySelector('input[placeholder="Search sessions..."]')),
        hasComposer:
          bodyText.includes("Bypass permissions") &&
          Boolean(doc?.querySelector('button[title="Show command menu (/)"]')),
        hasOldMainConfig: bodyText.includes("Main Config"),
        hasNativeSelect: Boolean(doc?.querySelector("select")),
        resources: [...(doc?.querySelectorAll("script[src],link[href]") ?? [])]
          .map((element) => element.src || element.href)
          .filter(Boolean)
      };
    })())`,
    returnByValue: true,
  });
  evidence.push({ targetId: target.id, ...JSON.parse(result.result.value) });
  client.close();
}

const expectedVersion = JSON.parse(
  readFileSync(new URL("../../extensions/vscode/package.json", import.meta.url), "utf8"),
).version;
const installedMarker = `/.vscode/extensions/cukii.cukii-vscode-${expectedVersion}/`;
const resourceVersionMatches = evidence.length > 0 && evidence.every((item) =>
  item.resources.some((url) => url.toLowerCase().includes(installedMarker)),
);
const uiMatches = evidence.some((item) => item.hasSearchSessions) &&
  evidence.some((item) => item.hasComposer) &&
  evidence.every((item) => !item.hasOldEmptyState && !item.hasOldMainConfig && !item.hasNativeSelect);

const receipt = { endpoint, targetCount: evidence.length, resourceVersionMatches, uiMatches, evidence };
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!resourceVersionMatches || !uiMatches) process.exitCode = 2;
