import { chromium } from "playwright-core";

const count = Number(process.argv[2] ?? 1);
const browser = await chromium.connectOverCDP(
  process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
);
const page = browser.contexts().flatMap((context) => context.pages()).find(
  (candidate) => candidate.url().startsWith("vscode-file://vscode-app/"),
);
if (!page) throw new Error("VS Code workbench page not found");
for (let index = 0; index < count; index++) {
  await page.keyboard.press("Control+W");
  await page.waitForTimeout(500);
}
await browser.close();
process.stdout.write(`${JSON.stringify({ status: "CLOSED", count })}\n`);
