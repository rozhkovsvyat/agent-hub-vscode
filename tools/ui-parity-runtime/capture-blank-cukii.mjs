import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("VS Code workbench page not found");

if (!process.argv.includes("--existing")) {
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Cukii: Open in new window");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
}

const candidates = (await listTargets(endpoint)).filter((target) =>
  target.type === "iframe" &&
  target.url.includes("extensionId=cukii.cukii-vscode") &&
  !target.url.includes("purpose=webviewView")
);
let blank;
for (const target of candidates) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: 'JSON.stringify(document.querySelector("#active-frame")?.contentDocument?.body?.innerText ?? "")',
  });
  if (JSON.parse(result.result.value).includes("Ready to code?")) {
    blank = { target, client };
    break;
  }
  client.close();
}
if (!blank) throw new Error("blank Cukii target not found");
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), "blank-cukii-live.png");
const editorFrames = page.locator(
  'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
);
const sources = await editorFrames.evaluateAll((elements) =>
  elements.map((element) => element.src),
);
const frameIndex = sources.indexOf(blank.target.url);
if (frameIndex < 0) throw new Error("blank Cukii outer frame not found");
const clip = await editorFrames.nth(frameIndex).boundingBox();
if (!clip) throw new Error("blank Cukii outer frame has no geometry");
await page.screenshot({ path: output, clip });
blank.client.close();

const close = page.locator(
  '.editor-group-container.active .tab.active.selected .tab-actions .action-label.codicon-close',
);
await close.click();
await page.waitForTimeout(500);
await browser.close();
process.stdout.write(`${output}\n`);
