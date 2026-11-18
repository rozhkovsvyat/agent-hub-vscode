import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { listTargets } from "./cdp-client.mjs";

const extensionId = process.argv[2] ?? "Anthropic.claude-code";
const filename = process.argv[3] ?? `${extensionId}.png`;
const requestedTargetId = process.argv[4];
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const outputDirectory =
  process.env.CUKII_CAPTURE_DIR ?? "D:/Brain/tmp/cukii-effort-speed-captures";
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error("VS Code workbench page missing");
  const candidates = page.locator(
    `iframe[src*="extensionId=${extensionId}"]:not([src*="purpose=webviewView"])`,
  );
  let locator;
  if (requestedTargetId) {
    const target = (await listTargets(endpoint)).find(
      (candidate) => candidate.id === requestedTargetId,
    );
    if (!target) throw new Error(`Target ${requestedTargetId} is missing`);
    const sources = await candidates.evaluateAll((elements) =>
      elements.map((element) => element.src),
    );
    const index = sources.indexOf(target.url);
    if (index >= 0) locator = candidates.nth(index);
  }
  for (
    let index = 0;
    !locator && index < (await candidates.count());
    index += 1
  ) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    const filter = candidate
      .contentFrame()
      .locator('input[placeholder*="Filter actions"]');
    if ((await filter.count()) > 0 && (await filter.first().isVisible())) {
      locator = candidate;
      break;
    }
  }
  if (!locator)
    throw new Error(
      `${extensionId}: visible editor with an open command menu is missing`,
    );
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${extensionId}: editor iframe has no box`);
  const output = path.join(outputDirectory, filename);
  await page.screenshot({ path: output, clip: box, animations: "disabled" });
  process.stdout.write(`${JSON.stringify({ output, box })}\n`);
} finally {
  await browser.close();
}
