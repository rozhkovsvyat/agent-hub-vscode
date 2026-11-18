import { chromium } from "playwright-core";
import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("VS Code workbench page not found");

const reuseExisting = process.argv.includes("--existing");
if (!reuseExisting) {
  await page.keyboard.press("Control+Shift+P");
  await page.keyboard.type("Cukii: Open Cukii in a New Tab");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(5000);
}

const targets = (await listTargets(endpoint)).filter((target) => {
  if (target.type !== "iframe") return false;
  const extensionId = new URL(target.url).searchParams.get("extensionId");
  return extensionId === "Anthropic.claude-code" || extensionId === "cukii.cukii-vscode";
});

const evidence = {};
for (const target of targets) {
  const extensionId = new URL(target.url).searchParams.get("extensionId");
  if (evidence[extensionId]) continue;
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `JSON.stringify((() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      const bodyText = doc?.body?.innerText ?? "";
      const isRelevant = ${JSON.stringify(extensionId)} === "Anthropic.claude-code"
        ? bodyText.includes("Tired of repeating yourself?")
        : bodyText.includes("Ready to code?");
      if (!isRelevant) return null;
      const nodes = [...doc.querySelectorAll("*")].flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return [];
        const text = (element.innerText ?? "").trim().replace(/\\s+/g, " ");
        const ownText = [...element.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent ?? "")
          .join(" ").trim().replace(/\\s+/g, " ");
        const selected =
          element.matches('[data-testid="cukii-empty-state"], [role="img"], svg, img') ||
          /Tired of repeating|Ready to code|Let's write something|^Cukii$/.test(ownText) ||
          /^Tired of repeating|^Ready to code|^Let's write something|^Cukii$/.test(text);
        if (!selected) return [];
        return [{
          tag: element.tagName,
          className: String(element.className?.baseVal ?? element.className ?? ""),
          testId: element.getAttribute("data-testid"),
          role: element.getAttribute("role"),
          text: text.slice(0, 220),
          ownText: ownText.slice(0, 220),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          style: {
            display: style.display,
            position: style.position,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            gap: style.gap,
            padding: style.padding,
            margin: style.margin,
          },
        }];
      });
      return {
        viewport: { width: innerWidth, height: innerHeight },
        bodyRect: doc.body.getBoundingClientRect().toJSON(),
        nodes,
      };
    })())`,
  });
  const value = JSON.parse(result.result.value);
  if (value) evidence[extensionId] = value;
  client.close();
}

if (!reuseExisting) {
  const close = page.locator(
    '.editor-group-container.active .tab.active.selected .tab-actions .action-label.codicon-close',
  );
  await close.click();
  await page.waitForTimeout(500);
}
await browser.close();
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
