import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(
  process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
);
const actionPrefix = process.argv[2] ?? "Open Cukii in a New Tab";
const page = browser.contexts().flatMap((context) => context.pages()).find(
  (candidate) => candidate.url().startsWith("vscode-file://vscode-app/"),
);
if (!page) throw new Error("VS Code workbench page not found");
const activityLabel = actionPrefix.startsWith("activity:")
  ? actionPrefix.slice("activity:".length)
  : null;
const action = page.locator(
  activityLabel
    ? `.activitybar a.action-label[aria-label="${activityLabel}"]`
    : `a.action-label[aria-label^="${actionPrefix}"]`,
);
if ((await action.count()) !== 1)
  throw new Error(`${actionPrefix}: editor-title action missing`);
await action.click();
await page.waitForTimeout(3000);
await browser.close();
process.stdout.write('{"status":"OPENED"}\n');
