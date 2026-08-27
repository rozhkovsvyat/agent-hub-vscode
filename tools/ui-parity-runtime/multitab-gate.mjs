import { chromium } from "playwright-core";
import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const browser = await chromium.connectOverCDP(endpoint);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("vscode-file://vscode-app/"));
if (!page) throw new Error("VS Code workbench page not found");

const editorSelector =
  'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])';

async function inspectPanels() {
  const outer = await page.locator(editorSelector).evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        src: element.getAttribute("src"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    }),
  );
  const targets = (await listTargets(endpoint)).filter((target) => {
    if (target.type !== "iframe") return false;
    const url = new URL(target.url);
    return url.searchParams.get("extensionId") === "cukii.cukii-vscode" &&
      url.searchParams.get("purpose") !== "webviewView";
  });
  const inner = [];
  for (const target of targets) {
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    await client.send("Runtime.enable");
    const result = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `JSON.stringify((() => {
        const frame = document.querySelector("#active-frame");
        return {
          panelId: frame?.contentWindow?.cukiiPanelId ?? null,
          sessionId: frame?.contentWindow?.initialSessionId ?? null,
          readyState: frame?.contentDocument?.readyState ?? null,
          bodyText: (frame?.contentDocument?.body?.innerText ?? "").slice(0, 80),
          inputText: frame?.contentDocument
            ?.querySelector('[contenteditable="true"]')?.innerText ?? ""
        };
      })())`,
    });
    client.close();
    inner.push({ targetId: target.id, targetUrl: target.url, ...JSON.parse(result.result.value) });
  }
  return { outer, inner };
}

async function waitForCount(expected, label) {
  const deadline = Date.now() + 15000;
  let snapshot = await inspectPanels();
  const isSettled = () =>
    snapshot.inner.length === expected &&
    snapshot.outer.length === expected &&
    snapshot.inner.every((panel) => panel.panelId && panel.readyState === "complete");
  while (Date.now() < deadline && !isSettled()) {
    await page.waitForTimeout(250);
    snapshot = await inspectPanels();
  }
  if (snapshot.inner.length !== expected || snapshot.outer.length !== expected) {
    throw new Error(`${label}: expected ${expected} editor panels, got outer=${snapshot.outer.length}, inner=${snapshot.inner.length}`);
  }
  if (snapshot.inner.some((panel) => !panel.panelId || panel.readyState !== "complete")) {
    throw new Error(`${label}: a panel has no id or is not ready`);
  }
  return snapshot;
}

const receipt = { endpoint, gestures: [], cleanup: [] };
const initial = await inspectPanels();
receipt.initial = initial;
const initialIds = new Set(initial.inner.map((panel) => panel.panelId));
const initialInputById = new Map(
  initial.inner.map((panel) => [panel.panelId, panel.inputText]),
);
let createdIds = [];

try {
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+C");
  await page.keyboard.press("u");
  receipt.gestures.push("ctrl+shift+c u");
  const afterCtrlShift = await waitForCount(initial.inner.length + 1, "ctrl+shift+c u");
  receipt.afterCtrlShift = afterCtrlShift;

  await page.keyboard.press("Shift+Alt+C");
  await page.keyboard.press("u");
  receipt.gestures.push("shift+alt+c u");
  const afterShiftAlt = await waitForCount(initial.inner.length + 2, "shift+alt+c u");
  receipt.afterShiftAlt = afterShiftAlt;

  createdIds = afterShiftAlt.inner
    .map((panel) => panel.panelId)
    .filter((panelId) => !initialIds.has(panelId));
  const allIds = afterShiftAlt.inner.map((panel) => panel.panelId);
  const existingInputsUnchanged = afterShiftAlt.inner
    .filter((panel) => initialIds.has(panel.panelId))
    .every((panel) => panel.inputText === initialInputById.get(panel.panelId));
  const createdPanelsBlank = afterShiftAlt.inner
    .filter((panel) => createdIds.includes(panel.panelId))
    .every((panel) => panel.inputText.trim() === "");
  receipt.invariants = {
    eachGestureAddsExactlyOnePanel:
      afterCtrlShift.inner.length === initial.inner.length + 1 &&
      afterShiftAlt.inner.length === initial.inner.length + 2,
    panelIdsAreUnique: new Set(allIds).size === allIds.length,
    createdTwoDistinctPanels: new Set(createdIds).size === 2,
    allPanelsReady: afterShiftAlt.inner.every((panel) => panel.readyState === "complete"),
    existingInputsUnchanged,
    createdPanelsBlank,
  };
  if (Object.values(receipt.invariants).some((value) => !value)) {
    throw new Error(`multitab invariants failed: ${JSON.stringify(receipt.invariants)}`);
  }
  receipt.status = "PASS";
} catch (error) {
  receipt.status = "FAIL";
  receipt.failure = { message: error instanceof Error ? error.message : String(error) };
  process.exitCode = 2;
} finally {
  if (createdIds.length === 0) {
    const current = await inspectPanels();
    createdIds = current.inner
      .map((panel) => panel.panelId)
      .filter((panelId) => !initialIds.has(panelId));
  }
  for (let index = 0; index < createdIds.length; index += 1) {
    const beforeClose = await inspectPanels();
    const closeButton = page.locator(
      '.editor-group-container.active .tab.active.selected .tab-actions .action-label.codicon-close',
    );
    if ((await closeButton.count()) !== 1) {
      throw new Error("cleanup: active editor close button not found");
    }
    await closeButton.click();
    const deadline = Date.now() + 10000;
    let afterClose = await inspectPanels();
    while (Date.now() < deadline && afterClose.inner.length !== beforeClose.inner.length - 1) {
      await page.waitForTimeout(250);
      afterClose = await inspectPanels();
    }
    receipt.cleanup.push("active-tab-close-button");
  }
  const afterCleanup = await inspectPanels();
  receipt.afterCleanup = afterCleanup;
  receipt.cleanupRestoredInitialCount = afterCleanup.inner.length === initial.inner.length;
  if (!receipt.cleanupRestoredInitialCount) process.exitCode = 3;
  await browser.close();
}

process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
