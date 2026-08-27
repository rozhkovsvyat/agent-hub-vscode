import { chromium } from "playwright-core";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("VS Code workbench page not found");

const groups = await page
  .locator(".editor-group-container")
  .evaluateAll((elements) =>
    elements.map((group, groupIndex) => ({
      groupIndex,
      active: group.classList.contains("active"),
      tabs: [...group.querySelectorAll(".tab")].map((tab) => ({
        text: (tab.textContent ?? "").trim(),
        title: tab.getAttribute("aria-label") ?? tab.getAttribute("title"),
        active: tab.classList.contains("active"),
        selected: tab.classList.contains("selected"),
      })),
    })),
  );
process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
await browser.close();
