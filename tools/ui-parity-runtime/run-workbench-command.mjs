import { chromium } from "playwright-core";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const command = process.argv.slice(2).join(" ").trim();

if (!command) {
  throw new Error("Usage: node run-workbench-command.mjs <command title>");
}

const browser = await chromium.connectOverCDP(endpoint);
try {
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) =>
    candidate.url().startsWith("vscode-file://"),
  );
  if (!page) {
    throw new Error(`VS Code workbench was not found at ${endpoint}`);
  }

  await page.bringToFront();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+P");
  const input = page.locator(".quick-input-widget input").first();
  await input.waitFor({ state: "visible", timeout: 10_000 });
  await input.fill(`>${command}`);
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2_500);
  process.stdout.write(
    `${JSON.stringify({ endpoint, command, title: await page.title() })}\n`,
  );
} finally {
  await browser.close();
}
