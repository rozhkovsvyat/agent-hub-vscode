import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(
  process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
);
const actionPrefix = process.argv[2] ?? "Open Cukii in a New Tab";
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("VS Code workbench page not found");
const onboarding = page.locator(
  '[role="dialog"][aria-label="Welcome to Visual Studio Code"]',
);
if (await onboarding.isVisible().catch(() => false)) {
  await page.keyboard.press("Escape");
  await onboarding.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
}
await page.keyboard.press("Escape");
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
await action.click({ force: true });
await page.waitForTimeout(3000);
const editorFrames = page.locator(
  'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
);
if ((await editorFrames.count()) === 0) {
  await page.keyboard.press("Shift+Alt+C");
  await page.keyboard.press("u");
  await page.waitForTimeout(3000);
}
await browser.close();
process.stdout.write('{"status":"OPENED"}\n');
