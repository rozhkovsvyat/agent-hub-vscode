import { chromium } from "playwright-core";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No VS Code workbench page found");

const matches = await page
  .locator(
    '[aria-label*="Claude" i], [title*="Claude" i], [aria-label*="Cukii" i], [title*="Cukii" i]',
  )
  .evaluateAll((elements) =>
    elements.map((element) => ({
      tag: element.tagName,
      className: element.className,
      ariaLabel: element.getAttribute("aria-label"),
      title: element.getAttribute("title"),
      text: element.textContent?.trim(),
      box: element.getBoundingClientRect().toJSON(),
    })),
  );
process.stdout.write(`${JSON.stringify(matches, null, 2)}\n`);
await browser.close();
