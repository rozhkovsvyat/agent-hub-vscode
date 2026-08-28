import { chromium } from "playwright-core";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const actionPrefix = process.argv.slice(2).join(" ").trim();
if (!actionPrefix) {
  throw new Error("usage: click-workbench-action.mjs <aria-label prefix>");
}

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("vscode-file://"));
  if (!page) throw new Error(`VS Code workbench missing at ${endpoint}`);
  const action = page.locator(
    `a.action-label[aria-label^=${JSON.stringify(actionPrefix)}]`,
  );
  if ((await action.count()) !== 1) {
    throw new Error(`${actionPrefix}: unique workbench action missing`);
  }
  await action.click({ force: true });
  await page.waitForTimeout(3000);
  process.stdout.write(
    `${JSON.stringify({ status: "CLICKED", endpoint, actionPrefix })}\n`,
  );
} finally {
  await browser.close();
}
