import { chromium } from "playwright-core";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const title = process.argv[2];
if (!title) throw new Error("usage: close-workbench-tabs.mjs <exact title>");

const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("VS Code workbench page not found");

let closed = 0;
for (;;) {
  const tabs = page.locator(".editor-group-container .tab").filter({
    has: page.locator(".tab-label", { hasText: title }),
  });
  const exact = [];
  for (let index = 0; index < (await tabs.count()); index += 1) {
    const tab = tabs.nth(index);
    const label = (await tab.locator(".tab-label").innerText()).trim();
    if (label === title) exact.push(tab);
  }
  if (exact.length === 0) break;
  const tab = exact[0];
  await tab.hover();
  await tab.locator(".tab-actions .codicon-close").click();
  closed += 1;
  await page.waitForTimeout(400);
}

process.stdout.write(`${JSON.stringify({ title, closed })}\n`);
await browser.close();
