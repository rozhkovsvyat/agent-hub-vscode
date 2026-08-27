import { chromium } from "playwright-core";
import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("workbench missing");
const editorTargets = async () => (await listTargets(endpoint)).filter((target) =>
  target.type === "iframe" &&
  target.url.includes("extensionId=cukii.cukii-vscode") &&
  !target.url.includes("purpose=webviewView"));
const initialTargets = await editorTargets();
const initialCount = initialTargets.length;
const initialIds = new Set(initialTargets.map((target) => target.id));

await page.keyboard.press("Control+Shift+P");
await page.keyboard.type("Cukii: Open in new window");
await page.keyboard.press("Enter");
await page.waitForTimeout(1200);
const firstTargets = await editorTargets();
if (firstTargets.length !== initialCount + 1) throw new Error("probe panel was not created");
const probeTarget = firstTargets.find((target) => !initialIds.has(target.id));
if (!probeTarget) throw new Error("new probe target missing");
const client = new CdpClient(probeTarget.webSocketDebuggerUrl);
await client.connect();
await client.send("Runtime.evaluate", {
  expression: `(() => {
    const view = document.querySelector("#active-frame")?.contentWindow;
    const doc = document.querySelector("#active-frame")?.contentDocument;
    const input = doc?.querySelector('[contenteditable="true"]');
    const bucket = [];
    window.__chordProbe = bucket;
    window.__chordProbeInput = input;
    for (const [scope, target] of [["view", view], ["doc", doc], ["input", input]]) {
      for (const type of ["keydown", "keyup", "beforeinput", "input"]) {
        target?.addEventListener(type, (event) => bucket.push({
          scope,
          type,
          key: event.key ?? null,
          code: event.code ?? null,
          ctrlKey: Boolean(event.ctrlKey),
          shiftKey: Boolean(event.shiftKey),
          altKey: Boolean(event.altKey),
          inputType: event.inputType ?? null,
          data: event.data ?? null,
          defaultPrevented: event.defaultPrevented,
        }), true);
      }
    }
    new MutationObserver(() => bucket.push({
      scope: "mutation",
      text: input?.innerText ?? "",
    })).observe(input, { childList: true, characterData: true, subtree: true });
  })()`,
});
let rectResult;
const rectDeadline = Date.now() + 15000;
do {
  rectResult = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      const input = doc?.querySelector('[contenteditable="true"]');
      return input?.getBoundingClientRect().toJSON() ?? null;
    })()`,
  });
  if (!rectResult.result.value) await page.waitForTimeout(250);
} while (!rectResult.result.value && Date.now() < rectDeadline);
const outerFrames = page.locator(
  'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
);
const sources = await outerFrames.evaluateAll((elements) => elements.map((element) => element.src));
const index = sources.indexOf(probeTarget.url);
if (index < 0) throw new Error("probe outer iframe missing");
const outerBox = await outerFrames.nth(index).boundingBox();
if (!outerBox || !rectResult.result.value) throw new Error("probe input geometry missing");
await page.mouse.click(
  outerBox.x + rectResult.result.value.x + 12,
  outerBox.y + rectResult.result.value.y + 12,
);
await page.keyboard.press("Shift+Alt+C");
await page.keyboard.press("u");
await page.waitForTimeout(1200);
const eventResult = await client.send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const doc = document.querySelector("#active-frame")?.contentDocument;
    return {
      events: window.__chordProbe,
      inputText: window.__chordProbeInput?.innerText ?? "",
      currentInputText: doc?.querySelector('[contenteditable="true"]')?.innerText ?? ""
    };
  })()`,
});
const afterCount = (await editorTargets()).length;
for (let index = 0; index < 2; index += 1) {
  const close = page.locator(
    '.editor-group-container.active .tab.active.selected .tab-actions .action-label.codicon-close',
  );
  await close.click();
  await page.waitForTimeout(500);
}
client.close();
await browser.close();
process.stdout.write(`${JSON.stringify({ initialCount, afterCount, ...eventResult.result.value }, null, 2)}\n`);
