import { chromium } from "playwright-core";
import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = "http://127.0.0.1:9222";
const target = (await listTargets(endpoint)).find((candidate) =>
  candidate.type === "iframe" &&
  candidate.url.includes("extensionId=Anthropic.claude-code") &&
  !candidate.url.includes("purpose=webviewView"));
if (!target) throw new Error("Claude editor target missing");
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
const inspect = async () => {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      const input = doc?.querySelector('[role="textbox"][aria-label="Message input"]');
      const rect = input?.getBoundingClientRect();
      return { text: input?.innerText ?? "", rect: rect?.toJSON() ?? null };
    })()`,
  });
  return result.result.value;
};
const before = await inspect();
if (before.text !== "uu" || !before.rect) {
  throw new Error(`refusing cleanup: expected exact test pollution "uu", got ${JSON.stringify(before.text)}`);
}
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
const outer = page.locator(
  'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
);
const box = await outer.boundingBox();
if (!box) throw new Error("Claude editor outer iframe unavailable");
await page.mouse.click(box.x + before.rect.x + 12, box.y + before.rect.y + 12);
await page.keyboard.press("Control+A");
await page.keyboard.press("Backspace");
await page.waitForTimeout(250);
const after = await inspect();
client.close();
await browser.close();
process.stdout.write(`${JSON.stringify({ before: before.text, after: after.text }, null, 2)}\n`);
if (after.text !== "") process.exitCode = 2;
