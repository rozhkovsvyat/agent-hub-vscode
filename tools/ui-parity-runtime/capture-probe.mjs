import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const outputDirectory =
  process.env.CUKII_CAPTURE_DIR ?? "D:/Brain/tmp/cukii-ui-parity-probe";
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No VS Code workbench page found through CDP");

const captures = [
  ["claude-sidebar", 'iframe[src*="extensionId=Anthropic.claude-code"]'],
  [
    "cukii-sidebar",
    'iframe[src*="extensionId=cukii.cukii-vscode"][src*="purpose=webviewView"]',
  ],
  [
    "cukii-editor",
    'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
  ],
];

const receipt = [];
for (const [id, selector] of captures) {
  const locator = page.locator(selector);
  if ((await locator.count()) !== 1)
    throw new Error(`${id}: expected exactly one iframe`);
  const box = await locator.boundingBox();
  process.stderr.write(
    `${id} ${JSON.stringify(box)} viewport=${JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })))}\n`,
  );
  if (!box || box.width <= 0 || box.height <= 0)
    throw new Error(`${id}: iframe is not visible`);
  await page.screenshot({
    path: path.join(outputDirectory, `${id}.png`),
    type: "png",
    clip: box,
    animations: "disabled",
    timeout: 10_000,
  });
  receipt.push({ id, selector, box });
}

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
await browser.close();
