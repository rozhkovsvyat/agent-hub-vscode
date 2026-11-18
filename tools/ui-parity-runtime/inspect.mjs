import { chromium } from "playwright-core";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint);

const inventory = [];
for (const [contextIndex, context] of browser.contexts().entries()) {
  for (const [pageIndex, page] of context.pages().entries()) {
    const frames = [];
    for (const frame of page.frames()) {
      let elementSrc = null;
      if (frame !== page.mainFrame()) {
        elementSrc = await frame
          .frameElement()
          .then((element) => element.getAttribute("src"));
      }
      frames.push({
        name: frame.name(),
        url: frame.url(),
        elementSrc,
        bodyText: await frame
          .locator("body")
          .innerText()
          .catch(() => "<unavailable>"),
      });
    }
    inventory.push({
      contextIndex,
      pageIndex,
      title: await page.title(),
      url: page.url(),
      frames,
      embedded: await page.locator("iframe, webview").evaluateAll((elements) =>
        elements.map((element) => ({
          tag: element.tagName,
          id: element.id,
          className: element.className,
          src: element.getAttribute("src"),
          title: element.getAttribute("title"),
        })),
      ),
    });
  }
}

process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
await browser.close();
