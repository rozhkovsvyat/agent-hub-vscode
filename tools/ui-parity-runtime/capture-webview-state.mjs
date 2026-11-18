import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const [extensionId, visibleText, filename = "webview-state.png"] =
  process.argv.slice(2);
if (!extensionId || !visibleText) {
  throw new Error(
    "usage: capture-webview-state.mjs <extensionId> <visible text> [filename]",
  );
}

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const outputDirectory =
  process.env.CUKII_CAPTURE_DIR ?? "D:/Brain/tmp/cukii-ui-parity-captures";
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error("VS Code workbench page missing");
  const frames = page.locator("iframe");
  let selected;
  for (let index = 0; index < (await frames.count()); index += 1) {
    const candidate = frames.nth(index);
    if (!(await candidate.isVisible())) continue;
    const source = (await candidate.getAttribute("src")) ?? "";
    if (!source.includes(`extensionId=${extensionId}`)) continue;
    selected = candidate;
    break;
  }
  if (!selected) {
    throw new Error(
      `${extensionId}: visible webview with ${visibleText} missing`,
    );
  }
  const box = await selected.boundingBox();
  if (!box) throw new Error(`${extensionId}: editor iframe has no box`);
  const output = path.join(outputDirectory, filename);
  await page.screenshot({ path: output, clip: box, animations: "disabled" });
  process.stdout.write(`${JSON.stringify({ output, box })}\n`);
} finally {
  await browser.close();
}
