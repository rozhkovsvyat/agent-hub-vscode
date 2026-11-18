import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const outputDirectory =
  process.env.CUKII_CAPTURE_DIR ??
  "D:/Brain/tmp/cukii-ui-parity-20260827/design/ui-parity/runtime-baseline";
const viewportTolerance = 1;

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts()[0]?.pages()[0];
if (!page) throw new Error("No VS Code workbench page found through CDP");

const viewport = await page.evaluate(() => ({
  width: innerWidth,
  height: innerHeight,
  dpr: devicePixelRatio,
  title: document.title,
}));

function isInsideViewport(box) {
  return (
    Boolean(box) &&
    box.width > 0 &&
    box.height > 0 &&
    box.x >= -viewportTolerance &&
    box.y >= -viewportTolerance &&
    box.x + box.width <= viewport.width + viewportTolerance &&
    box.y + box.height <= viewport.height + viewportTolerance
  );
}

async function activateView(label, selector) {
  const currentBox = await page.locator(selector).boundingBox();
  if (isInsideViewport(currentBox)) return;
  const icon = page.locator(`a.action-label[aria-label="${label}"]`).first();
  if ((await icon.count()) !== 1)
    throw new Error(`${label}: activity icon not found`);
  await icon.click();
  await page.waitForTimeout(700);
}

async function visibleBox(selector, id) {
  const locator = page.locator(selector);
  if ((await locator.count()) !== 1)
    throw new Error(`${id}: expected exactly one iframe`);
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0)
    throw new Error(`${id}: iframe has no visible box`);
  if (!isInsideViewport(box)) {
    throw new Error(
      `${id}: iframe is outside the visible workbench viewport: ${JSON.stringify(box)}`,
    );
  }
  return { locator, box };
}

async function inspectInnerTarget(extensionId, purpose) {
  const targets = await listTargets(endpoint);
  const matches = targets.filter((target) => {
    const url = new URL(target.url);
    if (url.searchParams.get("extensionId") !== extensionId) return false;
    return purpose === "editor"
      ? !url.searchParams.has("purpose")
      : url.searchParams.get("purpose") === purpose;
  });
  if (matches.length !== 1) {
    throw new Error(
      `${extensionId}/${purpose}: expected exactly one CDP target, got ${matches.length}`,
    );
  }

  const client = new CdpClient(matches[0].webSocketDebuggerUrl);
  await client.connect();
  try {
    const result = await client.send("Runtime.evaluate", {
      returnByValue: true,
      awaitPromise: true,
      expression: `(() => {
        const frame = document.querySelector("#active-frame");
        const doc = frame?.contentDocument;
        if (!doc?.body) throw new Error("active-frame contentDocument is unavailable");
        const style = (element) => {
          const computed = element.ownerDocument.defaultView.getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            id: element.id,
            className: String(element.className ?? ""),
            role: element.getAttribute("role"),
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            text: (element.innerText ?? element.textContent ?? "").trim().slice(0, 300),
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
            computed: {
              display: computed.display,
              position: computed.position,
              color: computed.color,
              backgroundColor: computed.backgroundColor,
              border: computed.border,
              borderRadius: computed.borderRadius,
              fontFamily: computed.fontFamily,
              fontSize: computed.fontSize,
              fontWeight: computed.fontWeight,
              lineHeight: computed.lineHeight,
              padding: computed.padding,
              margin: computed.margin,
            },
          };
        };
        const interactive = [...doc.querySelectorAll("button, input, textarea, select, [role], [aria-label], [title]")]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            const computed = element.ownerDocument.defaultView.getComputedStyle(element);
            return box.width > 0 && box.height > 0 && computed.visibility !== "hidden" && computed.display !== "none";
          })
          .map(style);
        return {
          readyState: doc.readyState,
          title: doc.title,
          bodyText: doc.body.innerText,
          bodyHtml: doc.body.innerHTML,
          viewport: {
            width: frame.contentWindow.innerWidth,
            height: frame.contentWindow.innerHeight,
            dpr: frame.contentWindow.devicePixelRatio,
          },
          bodyStyle: style(doc.body),
          interactive,
        };
      })()`,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return {
      targetId: matches[0].id,
      targetUrl: matches[0].url,
      ...result.result.value,
    };
  } finally {
    client.close();
  }
}

async function capture({ id, activityLabel, selector, extensionId, purpose }) {
  if (activityLabel) await activateView(activityLabel, selector);
  const { box } = await visibleBox(selector, id);
  const screenshotPath = path.join(outputDirectory, `${id}.png`);
  await page.screenshot({
    path: screenshotPath,
    type: "png",
    clip: box,
    animations: "disabled",
    timeout: 10_000,
  });
  const runtime = await inspectInnerTarget(extensionId, purpose);
  if (
    Math.abs(runtime.viewport.width - box.width) > viewportTolerance ||
    Math.abs(runtime.viewport.height - box.height) > viewportTolerance
  ) {
    throw new Error(
      `${id}: workbench/inner viewport mismatch: box=${JSON.stringify(box)} inner=${JSON.stringify(runtime.viewport)}`,
    );
  }
  const snapshotPath = path.join(outputDirectory, `${id}.json`);
  await writeFile(
    snapshotPath,
    `${JSON.stringify({ id, capturedAt: new Date().toISOString(), box, runtime }, null, 2)}\n`,
  );
  return { id, box, screenshotPath, snapshotPath };
}

const captures = [];
captures.push(
  await capture({
    id: "claude-sidebar",
    activityLabel: "Claude Code",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"][src*="purpose=webviewView"]',
    extensionId: "Anthropic.claude-code",
    purpose: "webviewView",
  }),
);
captures.push(
  await capture({
    id: "claude-editor",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    extensionId: "Anthropic.claude-code",
    purpose: "editor",
  }),
);
captures.push(
  await capture({
    id: "cukii-sidebar",
    activityLabel: "Cukii",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"][src*="purpose=webviewView"]',
    extensionId: "cukii.cukii-vscode",
    purpose: "webviewView",
  }),
);
captures.push(
  await capture({
    id: "cukii-editor",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    extensionId: "cukii.cukii-vscode",
    purpose: "editor",
  }),
);

for (const capture of captures) {
  for (const file of [capture.screenshotPath, capture.snapshotPath]) {
    const bytes = await readFile(file);
    capture[
      `${path.extname(file) === ".png" ? "screenshot" : "snapshot"}Sha256`
    ] = createHash("sha256").update(bytes).digest("hex");
  }
}

const receipt = {
  schemaVersion: 1,
  oracle: "playwright-cdp-vscode-live-webview",
  endpoint,
  capturedAt: new Date().toISOString(),
  workbench: viewport,
  assertions: {
    actualWorkbench: viewport.title.includes("Visual Studio Code"),
    allIframesVisible: true,
    allInnerViewportsMatchWorkbenchBoxes: true,
    rawInnerWebviewDomCaptured: true,
  },
  captures,
};
if (Object.values(receipt.assertions).some((value) => value !== true)) {
  throw new Error(
    `Oracle assertions failed: ${JSON.stringify(receipt.assertions)}`,
  );
}
await writeFile(
  path.join(outputDirectory, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

await browser.close();
