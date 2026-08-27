import { chromium } from "playwright-core";
import { listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const cukiiIds = async () => (await listTargets(endpoint))
  .filter((target) => target.type === "iframe" && target.url.includes("extensionId=cukii.cukii-vscode"))
  .map((target) => target.id)
  .sort();

const before = await cukiiIds();
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("VS Code workbench page not found");
await page.keyboard.press("Control+Shift+P");
await page.keyboard.type("Developer: Reload Window");
await page.keyboard.press("Enter");
await page.waitForTimeout(3500);
const deadline = Date.now() + 20000;
let after = await cukiiIds();
while (Date.now() < deadline && (after.length === 0 || after.some((id) => before.includes(id)))) {
  await page.waitForTimeout(500);
  after = await cukiiIds();
}
await browser.close();
const changed = after.length > 0 && after.every((id) => !before.includes(id));
process.stdout.write(`${JSON.stringify({ before, after, changed }, null, 2)}\n`);
if (!changed) process.exitCode = 2;
