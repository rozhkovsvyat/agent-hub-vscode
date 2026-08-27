import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";
import { CdpClient, listTargets } from "./cdp-client.mjs";
import {
  assertExactResourceBinding,
  assertSemanticTransition,
  assertStableCapture,
  assertStyleTransition,
} from "./oracle-guards.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const artifactRoot =
  process.env.CUKII_ORACLE_ROOT ??
  "D:/Brain/tmp/cukii-ui-parity-20260827/design/ui-parity/runtime-runs";
const runId = `${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(6).toString("hex")}`;
const runDirectory = path.join(artifactRoot, runId);
await mkdir(artifactRoot, { recursive: true });
await mkdir(runDirectory, { recursive: false });

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tupleKeys = ["id", "parentId", "origin", "extensionId", "purpose"];

function webviewTuple(rawUrl) {
  const url = new URL(rawUrl);
  return {
    protocol: url.protocol,
    host: url.host,
    pathname: url.pathname,
    ...Object.fromEntries(
      tupleKeys.map((key) => [key, url.searchParams.get(key)]),
    ),
  };
}

function tuplesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function correlateTarget(outerSrc) {
  const tuple = webviewTuple(outerSrc);
  const targets = await listTargets(endpoint);
  const matches = targets.filter((target) => {
    if (target.type !== "iframe") return false;
    try {
      return tuplesEqual(webviewTuple(target.url), tuple);
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new Error(
      `Outer iframe tuple has ${matches.length} CDP matches: ${JSON.stringify(tuple)}`,
    );
  }
  return { tuple, target: matches[0] };
}

function resourceUrlToPath(resourceUrl) {
  const url = new URL(resourceUrl);
  if (!url.hostname.startsWith("file+")) return null;
  const decoded = decodeURIComponent(url.pathname).replace(
    /^\/(?:([a-zA-Z]:))/u,
    "$1",
  );
  return path.normalize(decoded);
}

async function bindResources(resourceUrls) {
  const files = [];
  for (const resourceUrl of resourceUrls) {
    const filePath = resourceUrlToPath(resourceUrl);
    if (!filePath) continue;
    const bytes = await readFile(filePath);
    files.push({
      resourceUrl,
      filePath,
      size: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const roots = [
    ...new Set(
      files
        .map((file) => {
          const marker = `${path.sep}.vscode${path.sep}extensions${path.sep}`;
          const index = file.filePath
            .toLowerCase()
            .indexOf(marker.toLowerCase());
          if (index < 0) return null;
          const suffix = file.filePath.slice(index + marker.length);
          return file.filePath.slice(
            0,
            index + marker.length + suffix.indexOf(path.sep),
          );
        })
        .filter(Boolean),
    ),
  ];
  for (const root of roots) {
    const manifestPath = path.join(root, "package.json");
    const bytes = await readFile(manifestPath);
    files.push({
      resourceUrl: null,
      filePath: manifestPath,
      size: bytes.length,
      sha256: sha256(bytes),
      manifest: JSON.parse(String(bytes)),
    });
  }
  return files;
}

async function inspectTarget(target) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const response = await client.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const frame = document.querySelector("#active-frame");
        const doc = frame?.contentDocument;
        const view = frame?.contentWindow;
        if (!doc?.body || !view) throw new Error("active-frame contentDocument is unavailable");
        const snapshot = (element) => {
          const computed = view.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const left = Math.max(0, rect.left);
          const top = Math.max(0, rect.top);
          const right = Math.min(view.innerWidth, rect.right);
          const bottom = Math.min(view.innerHeight, rect.bottom);
          const intersectsViewport = right > left && bottom > top;
          const point = intersectsViewport ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
          const hit = point ? doc.elementFromPoint(point.x, point.y) : null;
          const hitTest = Boolean(hit && (hit === element || element.contains(hit)));
          return {
            tag: element.tagName,
            id: element.id,
            className: String(element.className ?? ""),
            role: element.getAttribute("role"),
            ariaLabel: element.getAttribute("aria-label"),
            title: element.getAttribute("title"),
            text: (element.innerText ?? element.textContent ?? "").trim().slice(0, 300),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
            intersectsViewport,
            hitTest,
            visible: intersectsViewport && hitTest && computed.display !== "none"
              && computed.visibility !== "hidden" && Number(computed.opacity) > 0,
            computed: {
              display: computed.display,
              visibility: computed.visibility,
              opacity: computed.opacity,
              position: computed.position,
              color: computed.color,
              backgroundColor: computed.backgroundColor,
              border: computed.border,
              borderRadius: computed.borderRadius,
              boxShadow: computed.boxShadow,
              fontFamily: computed.fontFamily,
              fontSize: computed.fontSize,
              fontWeight: computed.fontWeight,
              lineHeight: computed.lineHeight,
              padding: computed.padding,
              margin: computed.margin,
            },
          };
        };
        return {
          readyState: doc.readyState,
          bodyText: doc.body.innerText,
          bodyHtmlSha256Input: doc.body.innerHTML,
          viewport: { width: view.innerWidth, height: view.innerHeight, dpr: view.devicePixelRatio },
          theme: {
            bodyClass: doc.body.className,
            colorScheme: view.getComputedStyle(doc.documentElement).colorScheme,
            fontFamily: view.getComputedStyle(doc.body).fontFamily,
            fontSize: view.getComputedStyle(doc.body).fontSize,
            editorBackground: view.getComputedStyle(doc.documentElement).getPropertyValue("--vscode-editor-background"),
            foreground: view.getComputedStyle(doc.documentElement).getPropertyValue("--vscode-foreground"),
            zoom: view.devicePixelRatio,
          },
          frameRect: frame.getBoundingClientRect().toJSON(),
          resources: [...doc.querySelectorAll("script[src], link[href]")].map((element) => element.src || element.href),
          interactive: [...doc.querySelectorAll("button, input, textarea, select, [role], [aria-label], [title]")]
            .map(snapshot),
        };
      })()`,
    });
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails));
    const value = response.result.value;
    value.bodyHtmlSha256 = sha256(Buffer.from(value.bodyHtmlSha256Input));
    delete value.bodyHtmlSha256Input;
    value.bodyTextSha256 = sha256(Buffer.from(value.bodyText));
    value.visibleInteractiveSha256 = sha256(
      Buffer.from(
        JSON.stringify(
          value.interactive
            .filter((element) => element.visible)
            .map((element) => ({
              tag: element.tag,
              role: element.role,
              ariaLabel: element.ariaLabel,
              title: element.title,
              text: element.text,
              rect: element.rect,
              computed: element.computed,
            })),
        ),
      ),
    );
    value.resourceBinding = await bindResources(value.resources);
    return value;
  } finally {
    client.close();
  }
}

async function inspectVisibleMatches(target, descriptor) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const descriptor = ${JSON.stringify(descriptor)};
        const frame = document.querySelector("#active-frame");
        const doc = frame?.contentDocument;
        const view = frame?.contentWindow;
        if (!doc || !view) throw new Error("active-frame unavailable");
        const candidates = [...doc.querySelectorAll(
          descriptor.textExact !== undefined
            ? "*"
            : "button, input, textarea, select, [role], [aria-label], [title], [placeholder]"
        )];
        const matches = candidates.filter((candidate) => {
          const text = (candidate.innerText ?? candidate.textContent ?? "").trim();
          const title = candidate.getAttribute("title") ?? "";
          const aria = candidate.getAttribute("aria-label") ?? "";
          const role = candidate.getAttribute("role") ?? "";
          const placeholder = candidate.getAttribute("placeholder") ?? "";
          if (descriptor.tag && candidate.tagName !== descriptor.tag.toUpperCase()) return false;
          if (descriptor.titleExact !== undefined && title !== descriptor.titleExact) return false;
          if (descriptor.titleIncludes !== undefined && !title.includes(descriptor.titleIncludes)) return false;
          if (descriptor.ariaExact !== undefined && aria !== descriptor.ariaExact) return false;
          if (descriptor.roleExact !== undefined && role !== descriptor.roleExact) return false;
          if (descriptor.placeholderExact !== undefined && placeholder !== descriptor.placeholderExact) return false;
          if (descriptor.placeholderIncludes !== undefined && !placeholder.includes(descriptor.placeholderIncludes)) return false;
          if (descriptor.textExact !== undefined && text !== descriptor.textExact) return false;
          if (descriptor.textStartsWith !== undefined && !text.startsWith(descriptor.textStartsWith)) return false;
          const rect = candidate.getBoundingClientRect();
          const point = rect.width > 0 && rect.height > 0
            ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            : null;
          const hit = point ? doc.elementFromPoint(point.x, point.y) : null;
          return Boolean(hit && (hit === candidate || candidate.contains(hit)));
        }).map((candidate) => {
          const computed = view.getComputedStyle(candidate);
          return {
            tag: candidate.tagName,
            text: (candidate.innerText ?? candidate.textContent ?? "").trim().slice(0, 120),
            title: candidate.getAttribute("title"),
            ariaLabel: candidate.getAttribute("aria-label"),
            role: candidate.getAttribute("role"),
            computed: {
              backgroundColor: computed.backgroundColor,
              color: computed.color,
              border: computed.border,
            },
          };
        });
        return { visibleCount: matches.length, matches };
      })()`,
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  } finally {
    client.close();
  }
}

function cropPhysical(fullBytes, box, workbenchViewport) {
  const source = PNG.sync.read(fullBytes);
  const scaleX = source.width / workbenchViewport.width;
  const scaleY = source.height / workbenchViewport.height;
  const left = Math.max(0, Math.round(box.x * scaleX));
  const top = Math.max(0, Math.round(box.y * scaleY));
  const right = Math.min(
    source.width,
    Math.round((box.x + box.width) * scaleX),
  );
  const bottom = Math.min(
    source.height,
    Math.round((box.y + box.height) * scaleY),
  );
  const output = new PNG({ width: right - left, height: bottom - top });
  PNG.bitblt(source, output, left, top, output.width, output.height, 0, 0);
  return {
    bytes: PNG.sync.write(output),
    source: { width: source.width, height: source.height },
    crop: {
      left,
      top,
      right,
      bottom,
      width: output.width,
      height: output.height,
      scaleX,
      scaleY,
    },
  };
}

const browser = await chromium.connectOverCDP(endpoint);
const pages = browser
  .contexts()
  .flatMap((context) => context.pages())
  .filter((candidate) =>
    candidate.url().startsWith("vscode-file://vscode-app/"),
  );
if (pages.length !== 1)
  throw new Error(`Expected one VS Code workbench page, got ${pages.length}`);
const page = pages[0];
const initialWorkbench = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  width: innerWidth,
  height: innerHeight,
  dpr: devicePixelRatio,
  bodyClass: document.body.className,
  activeActivity:
    document
      .querySelector(".activitybar .action-item.checked > a.action-label")
      ?.getAttribute("aria-label") ?? null,
  focusedEditorResource:
    document
      .querySelector(".editor-group-container.active .tab.active.selected")
      ?.getAttribute("data-resource-name") ?? null,
  activeElement:
    document.activeElement?.getAttribute("aria-label") ??
    document.activeElement?.className ??
    null,
}));
const targetInventory = await listTargets(endpoint);
const workbenchTargets = targetInventory.filter(
  (target) => target.type === "page" && target.url === initialWorkbench.url,
);
if (workbenchTargets.length !== 1)
  throw new Error(
    `Expected one exact workbench CDP target, got ${workbenchTargets.length}`,
  );
const workbenchTarget = workbenchTargets[0];
const workbenchClient = new CdpClient(workbenchTarget.webSocketDebuggerUrl);
await workbenchClient.connect();

async function ensureActivity(label, selector) {
  const locator = page.locator(selector).filter({ visible: true });
  const box = (await locator.count()) === 1 ? await locator.boundingBox() : null;
  const visible =
    box &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= initialWorkbench.width &&
    box.y + box.height <= initialWorkbench.height;
  if (visible) return;
  const icon = page.locator(`a.action-label[aria-label="${label}"]`).first();
  if ((await icon.count()) !== 1)
    throw new Error(`${label}: activity icon not found`);
  await icon.click();
  await page.waitForTimeout(500);
}

const assertions = [];
const interactions = [];

async function replaceVisibleSearchValue(id, selector, value) {
  const locator = page.locator(selector).filter({ visible: true });
  if ((await locator.count()) !== 1)
    throw new Error(`${id}: expected one sidebar iframe`);
  const outerBox = await locator.boundingBox();
  const outerSrc = await locator.getAttribute("src");
  if (!outerBox || !outerSrc) throw new Error(`${id}: sidebar iframe unavailable`);
  const correlated = await correlateTarget(outerSrc);
  const client = new CdpClient(correlated.target.webSocketDebuggerUrl);
  await client.connect();
  let field;
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const doc = document.querySelector("#active-frame")?.contentDocument;
        const inputs = [...(doc?.querySelectorAll("input") ?? [])]
          .filter((input) => (input.placeholder ?? "").includes("Search sessions"));
        const visible = inputs.filter((input) => {
          const rect = input.getBoundingClientRect();
          const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return hit && (hit === input || input.contains(hit));
        });
        if (visible.length !== 1) return { matches: visible.length };
        const input = visible[0];
        const rect = input.getBoundingClientRect();
        return {
          matches: 1,
          value: input.value,
          point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        };
      })()`,
    });
    field = response.result.value;
  } finally {
    client.close();
  }
  if (field.matches !== 1)
    throw new Error(
      `${id}: search input not uniquely visible (visible matches: ${field.matches})`,
    );
  await page.mouse.click(outerBox.x + field.point.x, outerBox.y + field.point.y);
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  if (value) await page.keyboard.type(value);
  await page.waitForTimeout(200);
  interactions.push({ id, action: "replace-search", from: field.value, to: value });
  return field.value;
}

async function captureState({ id, selector, activityLabel = null }) {
  if (activityLabel) await ensureActivity(activityLabel, selector);
  const locator = page.locator(selector).filter({ visible: true });
  if ((await locator.count()) !== 1)
    throw new Error(`${id}: expected one outer iframe`);
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0)
    throw new Error(`${id}: outer iframe has no box`);
  const outerSrc = await locator.getAttribute("src");
  if (!outerSrc) throw new Error(`${id}: outer iframe has no src`);
  const workbenchViewportBefore = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  const before = await correlateTarget(outerSrc);
  const runtime = await inspectTarget(before.target);
  const resourceEvidence = assertExactResourceBinding(
    runtime,
    before.tuple.extensionId,
  );
  if (
    Math.abs(runtime.viewport.width - box.width) > 1 ||
    Math.abs(runtime.viewport.height - box.height) > 1
  ) {
    throw new Error(`${id}: inner viewport does not match outer iframe box`);
  }
  const screenshot = await workbenchClient.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const fullBytes = Buffer.from(screenshot.data, "base64");
  const cropped = cropPhysical(fullBytes, box, initialWorkbench);
  const outerSrcAfter = await locator.getAttribute("src");
  const boxAfter = await locator.boundingBox();
  if (!outerSrcAfter || !boxAfter)
    throw new Error(`${id}: outer iframe disappeared during capture`);
  const workbenchViewportAfter = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  const after = await correlateTarget(outerSrcAfter);
  const runtimeAfter = await inspectTarget(after.target);
  assertExactResourceBinding(runtimeAfter, after.tuple.extensionId);
  assertStableCapture(
    {
      outerSrc,
      tuple: before.tuple,
      targetId: before.target.id,
      targetUrl: before.target.url,
      box,
      workbenchViewport: workbenchViewportBefore,
      bodyTextSha256: runtime.bodyTextSha256,
      visibleInteractiveSha256: runtime.visibleInteractiveSha256,
      innerViewport: runtime.viewport,
      resources: runtime.resources,
    },
    {
      outerSrc: outerSrcAfter,
      tuple: after.tuple,
      targetId: after.target.id,
      targetUrl: after.target.url,
      box: boxAfter,
      workbenchViewport: workbenchViewportAfter,
      bodyTextSha256: runtimeAfter.bodyTextSha256,
      visibleInteractiveSha256: runtimeAfter.visibleInteractiveSha256,
      innerViewport: runtimeAfter.viewport,
      resources: runtimeAfter.resources,
    },
  );
  const screenshotFile = path.join(runDirectory, `${id}.png`);
  const fullScreenshotFile = path.join(runDirectory, `${id}.full.png`);
  const snapshotFile = path.join(runDirectory, `${id}.json`);
  await writeFile(fullScreenshotFile, fullBytes, { flag: "wx" });
  await writeFile(screenshotFile, cropped.bytes, { flag: "wx" });
  const snapshot = {
    id,
    capturedAt: new Date().toISOString(),
    workbenchTargetId: workbenchTarget.id,
    outer: { src: outerSrc, tuple: before.tuple, box },
    inner: {
      targetId: before.target.id,
      targetUrl: before.target.url,
      ...runtime,
    },
    captureStability: {
      before: {
        workbenchViewport: workbenchViewportBefore,
        bodyHtmlSha256: runtime.bodyHtmlSha256,
        bodyTextSha256: runtime.bodyTextSha256,
        visibleInteractiveSha256: runtime.visibleInteractiveSha256,
      },
      after: {
        outerSrc: outerSrcAfter,
        box: boxAfter,
        workbenchViewport: workbenchViewportAfter,
        targetId: after.target.id,
        targetUrl: after.target.url,
        bodyHtmlSha256: runtimeAfter.bodyHtmlSha256,
        bodyTextSha256: runtimeAfter.bodyTextSha256,
        visibleInteractiveSha256: runtimeAfter.visibleInteractiveSha256,
      },
    },
    resourceEvidence,
    physicalCapture: {
      fullScreenshotFile,
      fullSha256: sha256(fullBytes),
      regionSha256: sha256(cropped.bytes),
      ...cropped.crop,
      fullSize: cropped.source,
    },
  };
  await writeFile(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
    flag: "wx",
  });
  return {
    id,
    screenshotFile,
    fullScreenshotFile,
    snapshotFile,
    screenshotSha256: snapshot.physicalCapture.regionSha256,
    snapshotSha256: sha256(await readFile(snapshotFile)),
    targetId: before.target.id,
    tuple: before.tuple,
    box,
    resourceEvidence,
    physicalCapture: snapshot.physicalCapture,
  };
}

async function gesture({
  id,
  selector,
  match,
  action,
  button = "left",
  optional = false,
  postcondition = null,
}) {
  const locator = page.locator(selector).filter({ visible: true });
  if ((await locator.count()) !== 1)
    throw new Error(`${id}: expected one outer iframe`);
  const outerBox = await locator.boundingBox();
  const outerSrc = await locator.getAttribute("src");
  if (!outerBox || !outerSrc)
    throw new Error(`${id}: outer iframe is unavailable`);
  const correlated = await correlateTarget(outerSrc);
  const semanticBefore = postcondition
    ? await inspectVisibleMatches(correlated.target, postcondition.match)
    : null;
  const client = new CdpClient(correlated.target.webSocketDebuggerUrl);
  await client.connect();
  let element;
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const descriptor = ${JSON.stringify({ ...match, hittable: true })};
        const frame = document.querySelector("#active-frame");
        const doc = frame?.contentDocument;
        const view = frame?.contentWindow;
        if (!doc || !view) throw new Error("active-frame unavailable");
        const candidates = [...doc.querySelectorAll("button, input, textarea, select, [role], [aria-label], [title]")];
        const matches = candidates.filter((candidate) => {
          const text = (candidate.innerText ?? candidate.textContent ?? "").trim();
          const title = candidate.getAttribute("title") ?? "";
          const aria = candidate.getAttribute("aria-label") ?? "";
          if (descriptor.tag && candidate.tagName !== descriptor.tag.toUpperCase()) return false;
          if (descriptor.titleExact !== undefined && title !== descriptor.titleExact) return false;
          if (descriptor.titleIncludes !== undefined && !title.includes(descriptor.titleIncludes)) return false;
          if (descriptor.ariaExact !== undefined && aria !== descriptor.ariaExact) return false;
          if (descriptor.textExact !== undefined && text !== descriptor.textExact) return false;
          if (descriptor.textIncludes !== undefined && !text.includes(descriptor.textIncludes)) return false;
          if (descriptor.textStartsWith !== undefined && !text.startsWith(descriptor.textStartsWith)) return false;
          if (descriptor.hittable) {
            const rect = candidate.getBoundingClientRect();
            const point = rect.width > 0 && rect.height > 0
              ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
              : null;
            const hit = point ? doc.elementFromPoint(point.x, point.y) : null;
            if (!hit || (hit !== candidate && !candidate.contains(hit))) return false;
          }
          return true;
        });
        if (matches.length !== 1) return { matches: matches.length, descriptor };
        const candidate = matches[0];
        const rect = candidate.getBoundingClientRect();
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(view.innerWidth, rect.right);
        const bottom = Math.min(view.innerHeight, rect.bottom);
        const point = right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
        const hit = point ? doc.elementFromPoint(point.x, point.y) : null;
        return {
          matches: 1,
          tag: candidate.tagName,
          text: (candidate.innerText ?? candidate.textContent ?? "").trim(),
          title: candidate.getAttribute("title"),
          ariaLabel: candidate.getAttribute("aria-label"),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          point,
          hitTest: Boolean(hit && (hit === candidate || candidate.contains(hit))),
        };
      })()`,
    });
    if (response.exceptionDetails)
      throw new Error(JSON.stringify(response.exceptionDetails));
    element = response.result.value;
  } finally {
    client.close();
  }
  if (optional && element.matches === 0) {
    interactions.push({
      id,
      at: new Date().toISOString(),
      action: "optional-gesture-skipped",
      match,
    });
    return null;
  }
  if (element.matches !== 1 || !element.point || !element.hitTest) {
    throw new Error(
      `${id}: gesture target is not uniquely hittable: ${JSON.stringify(element)}`,
    );
  }
  const point = {
    x: outerBox.x + element.point.x,
    y: outerBox.y + element.point.y,
  };
  if (action === "hover") await page.mouse.move(point.x, point.y);
  else if (action === "click")
    await page.mouse.click(point.x, point.y, { button });
  else throw new Error(`${id}: unsupported action ${action}`);
  await page.waitForTimeout(350);
  const after = await correlateTarget(outerSrc);
  if (after.target.id !== correlated.target.id)
    throw new Error(`${id}: target changed after gesture`);
  const semanticAfter = postcondition
    ? await inspectVisibleMatches(after.target, postcondition.match)
    : null;
  if (postcondition?.kind === "becomes-visible") {
    assertSemanticTransition(id, semanticBefore, semanticAfter);
  } else if (postcondition?.kind === "style-changes") {
    assertStyleTransition(
      id,
      semanticBefore,
      semanticAfter,
      postcondition.property,
    );
  }
  if (postcondition) {
    assertions.push({
      id,
      kind: postcondition.kind,
      match: postcondition.match,
      before: semanticBefore,
      after: semanticAfter,
      pass: true,
    });
  }
  const evidence = {
    id,
    at: new Date().toISOString(),
    action,
    button,
    outerSrc,
    targetId: correlated.target.id,
    match,
    element,
    postcondition,
    workbenchPoint: point,
  };
  interactions.push(evidence);
  return evidence;
}

async function assertVisibleState(id, selector, match, expectedVisible) {
  const locator = page.locator(selector).filter({ visible: true });
  const outerSrc = await locator.getAttribute("src");
  if (!outerSrc) throw new Error(`${id}: outer iframe is unavailable`);
  const correlated = await correlateTarget(outerSrc);
  const state = await inspectVisibleMatches(correlated.target, match);
  const pass = expectedVisible ? state.visibleCount >= 1 : state.visibleCount === 0;
  if (!pass) {
    throw new Error(
      `${id}: expected visible=${expectedVisible}, got ${state.visibleCount}`,
    );
  }
  assertions.push({ id, kind: "visible-state", match, expectedVisible, state, pass });
}

async function inspectThinkingState(selector) {
  const locator = page.locator(selector).filter({ visible: true });
  const outerSrc = await locator.getAttribute("src");
  if (!outerSrc) throw new Error("thinking-state: outer iframe is unavailable");
  const correlated = await correlateTarget(outerSrc);
  const client = new CdpClient(correlated.target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const doc = document.querySelector("#active-frame")?.contentDocument;
        const toggle = doc?.querySelector('[data-testid="cukii-thinking-toggle"]');
        const track = doc?.querySelector('[data-testid="cukii-thinking-track"]');
        const filter = doc?.querySelector('input[placeholder*="Filter actions"]');
        if (!toggle || !track || !filter) return null;
        const rect = filter.getBoundingClientRect();
        const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          checked: toggle.getAttribute("aria-checked") === "true",
          trackBackground: getComputedStyle(track).backgroundColor,
          menuVisible: Boolean(hit && (hit === filter || filter.contains(hit))),
        };
      })()`,
    });
    return response.result.value;
  } finally {
    client.close();
  }
}

async function assertMenuOccludesTimeline(id, selector) {
  const locator = page.locator(selector).filter({ visible: true });
  const outerSrc = await locator.getAttribute("src");
  if (!outerSrc) throw new Error(`${id}: outer iframe is unavailable`);
  const correlated = await correlateTarget(outerSrc);
  const client = new CdpClient(correlated.target.webSocketDebuggerUrl);
  await client.connect();
  let state;
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const doc = document.querySelector("#active-frame")?.contentDocument;
        const menu = doc?.querySelector('[data-testid="cukii-slash-menu"]')?.closest('.cukii-menu-surface');
        if (!doc || !menu) return { menuVisible: false, overlaps: [], pass: false };
        const menuRect = menu.getBoundingClientRect();
        const overlaps = [...doc.querySelectorAll('.cukii-timeline-item')].flatMap((item) => {
          const rect = item.getBoundingClientRect();
          const point = { x: rect.left + 12.5, y: rect.top + 8.5 };
          const inside = point.x >= menuRect.left && point.x <= menuRect.right && point.y >= menuRect.top && point.y <= menuRect.bottom;
          if (!inside) return [];
          const hit = doc.elementFromPoint(point.x, point.y);
          return [{
            point,
            hitTag: hit?.tagName ?? null,
            hitClass: String(hit?.className ?? ""),
            occludedByMenu: Boolean(hit && menu.contains(hit)),
          }];
        });
        return {
          menuVisible: true,
          menuRect: { x: menuRect.x, y: menuRect.y, width: menuRect.width, height: menuRect.height },
          overlaps,
          pass: overlaps.every((entry) => entry.occludedByMenu),
        };
      })()`,
    });
    state = response.result.value;
  } finally {
    client.close();
  }
  if (!state.pass) {
    throw new Error(`${id}: timeline dots pierce menu: ${JSON.stringify(state)}`);
  }
  assertions.push({ id, kind: "overlay-occlusion", state, pass: true });
}

async function escape(id) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  interactions.push({
    id,
    at: new Date().toISOString(),
    action: "keyboard",
    key: "Escape",
  });
}

async function focusAndDismiss(id, selector) {
  const locator = page.locator(selector).filter({ visible: true });
  if ((await locator.count()) !== 1)
    throw new Error(`${id}: expected one outer iframe`);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${id}: outer iframe is unavailable`);
  await page.mouse.click(box.x + Math.min(12, box.width / 2), box.y + Math.min(24, box.height / 2));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  interactions.push({
    id,
    at: new Date().toISOString(),
    action: "focus-and-dismiss",
    selector,
  });
}

const states = [];
const normalizedSearches = [];
let failure;
try {
  for (const search of [
    {
      id: "normalize-claude-search",
      activityLabel: "Claude Code",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"][src*="purpose=webviewView"]',
    },
    {
      id: "normalize-cukii-search",
      activityLabel: "Cukii",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"][src*="purpose=webviewView"]',
    },
  ]) {
    await ensureActivity(search.activityLabel, search.selector);
    const originalValue = await replaceVisibleSearchValue(
      search.id,
      search.selector,
      "",
    );
    normalizedSearches.push({ ...search, originalValue });
  }
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.mouse.move(8, 8);
  await page.waitForTimeout(250);
  states.push(
    await captureState({
      id: "claude-sidebar-default",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"][src*="purpose=webviewView"]',
      activityLabel: "Claude Code",
    }),
  );
  await gesture({
    id: "claude-close-stale-dialog",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", ariaExact: "Close", hittable: true },
    action: "click",
    optional: true,
  });
  await focusAndDismiss(
    "claude-clean-editor-overlays",
    'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
  );
  states.push(
    await captureState({
      id: "claude-editor-default",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    }),
  );
  await gesture({
    id: "claude-hover-add",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", titleExact: "Add" },
    action: "hover",
    postcondition: {
      kind: "style-changes",
      match: { tag: "button", titleExact: "Add" },
      property: "backgroundColor",
    },
  });
  states.push(
    await captureState({
      id: "claude-editor-hover-add",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    }),
  );
  await gesture({
    id: "claude-click-slash",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", titleExact: "Show command menu (/)" },
    action: "click",
    postcondition: {
      kind: "becomes-visible",
      match: { tag: "input", placeholderIncludes: "Filter actions" },
    },
  });
  states.push(
    await captureState({
      id: "claude-editor-slash-menu",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    }),
  );
  await gesture({
    id: "claude-click-switch-model",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    match: { titleExact: "Change the AI model" },
    action: "click",
    postcondition: {
      kind: "becomes-visible",
      match: { textExact: "Select a model" },
    },
  });
  states.push(
    await captureState({
      id: "claude-editor-model-picker",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    }),
  );
  await escape("claude-close-model-picker");
  await assertVisibleState(
    "claude-model-picker-closed",
    'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    { textExact: "Select a model" },
    false,
  );
  await gesture({
    id: "claude-hover-bypass",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", titleIncludes: "will not ask for approval" },
    action: "hover",
    postcondition: {
      kind: "style-changes",
      match: { tag: "button", titleIncludes: "will not ask for approval" },
      property: "backgroundColor",
    },
  });
  states.push(
    await captureState({
      id: "claude-editor-hover-bypass",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"]:not([src*="purpose=webviewView"])',
    }),
  );
  await gesture({
    id: "claude-sidebar-contextmenu",
    selector:
      'iframe[src*="extensionId=Anthropic.claude-code"][src*="purpose=webviewView"]',
    match: { tag: "button", textStartsWith: "[cu]" },
    action: "click",
    button: "right",
    postcondition: {
      kind: "becomes-visible",
      match: { tag: "button", textExact: "Switch to session" },
    },
  });
  states.push(
    await captureState({
      id: "claude-sidebar-context-menu",
      selector:
        'iframe[src*="extensionId=Anthropic.claude-code"][src*="purpose=webviewView"]',
      activityLabel: "Claude Code",
    }),
  );
  await escape("claude-close-context-menu");
  await assertVisibleState(
    "claude-context-menu-closed",
    'iframe[src*="extensionId=Anthropic.claude-code"][src*="purpose=webviewView"]',
    { tag: "button", textExact: "Switch to session" },
    false,
  );
  states.push(
    await captureState({
      id: "cukii-sidebar-default",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"][src*="purpose=webviewView"]',
      activityLabel: "Cukii",
    }),
  );
  await focusAndDismiss(
    "cukii-clean-editor-overlays",
    'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
  );
  states.push(
    await captureState({
      id: "cukii-editor-default",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    }),
  );
  await gesture({
    id: "cukii-start-voice-input",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", ariaExact: "Voice dictation" },
    action: "click",
  });
  const activeCukiiEditorSrc = await page
    .locator('iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])')
    .filter({ visible: true })
    .getAttribute("src");
  if (!activeCukiiEditorSrc)
    throw new Error("cukii-voice-input: active editor iframe unavailable");
  const voiceListening = await inspectVisibleMatches(
    (await correlateTarget(activeCukiiEditorSrc)).target,
    { tag: "button", titleExact: "Stop voice input" },
  );
  const voicePermissionDenied = await inspectVisibleMatches(
    (await correlateTarget(activeCukiiEditorSrc)).target,
    { tag: "button", titleExact: "Microphone permission is required" },
  );
  if (voiceListening.visibleCount + voicePermissionDenied.visibleCount !== 1)
    throw new Error("cukii-voice-input: click produced neither listening nor explicit permission state");
  assertions.push({
    id: "cukii-voice-input-runtime",
    kind: "runtime-state",
    listening: voiceListening,
    permissionDenied: voicePermissionDenied,
    pass: true,
  });
  await gesture({
    id: "cukii-stop-or-retry-voice-input",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", ariaExact: "Voice dictation" },
    action: "click",
  });
  await gesture({
    id: "cukii-hover-attach",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", ariaExact: "Attach" },
    action: "hover",
    postcondition: {
      kind: "style-changes",
      match: { tag: "button", ariaExact: "Attach" },
      property: "backgroundColor",
    },
  });
  states.push(
    await captureState({
      id: "cukii-editor-hover-attach",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    }),
  );
  await gesture({
    id: "cukii-click-slash",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", ariaExact: "Commands and model" },
    action: "click",
    postcondition: {
      kind: "becomes-visible",
      match: { tag: "input", placeholderIncludes: "Filter actions" },
    },
  });
  states.push(
    await captureState({
      id: "cukii-editor-slash-menu",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    }),
  );
  await assertMenuOccludesTimeline(
    "cukii-slash-menu-occludes-timeline",
    'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
  );
  const thinkingBefore = await inspectThinkingState(
    'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
  );
  if (!thinkingBefore?.menuVisible)
    throw new Error("cukii-thinking-toggle: slash menu is not visible before toggle");
  if (!thinkingBefore.checked) {
    await gesture({
      id: "cukii-enable-thinking",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
      match: { tag: "button", textExact: "Thinking" },
      action: "click",
    });
  }
  const thinkingEnabled = await inspectThinkingState(
    'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
  );
  if (
    !thinkingEnabled?.checked ||
    !thinkingEnabled.menuVisible ||
    thinkingEnabled.trackBackground !== "rgb(244, 135, 113)"
  ) {
    throw new Error(
      `cukii-thinking-toggle: expected open menu and orange enabled track, got ${JSON.stringify(thinkingEnabled)}`,
    );
  }
  assertions.push({
    id: "cukii-thinking-toggle-stays-open-and-orange",
    kind: "runtime-state",
    state: thinkingEnabled,
    pass: true,
  });
  if (!thinkingBefore.checked) {
    await gesture({
      id: "cukii-restore-thinking",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
      match: { tag: "button", textExact: "Thinking" },
      action: "click",
    });
  }
  const thinkingRestored = await inspectThinkingState(
    'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
  );
  if (!thinkingRestored?.menuVisible || thinkingRestored.checked !== thinkingBefore.checked)
    throw new Error("cukii-thinking-toggle: state was not restored with menu left open");
  await gesture({
    id: "cukii-click-switch-model",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", textStartsWith: "Switch model…" },
    action: "click",
    postcondition: {
      kind: "becomes-visible",
      match: { textExact: "Select a model" },
    },
  });
  states.push(
    await captureState({
      id: "cukii-editor-model-picker",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    }),
  );
  await escape("cukii-close-model-picker");
  await assertVisibleState(
    "cukii-model-picker-closed",
    'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    { textExact: "Select a model" },
    false,
  );
  await gesture({
    id: "cukii-hover-bypass",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    match: { tag: "button", textExact: "Bypass permissions" },
    action: "hover",
    postcondition: {
      kind: "style-changes",
      match: { tag: "button", textExact: "Bypass permissions" },
      property: "backgroundColor",
    },
  });
  states.push(
    await captureState({
      id: "cukii-editor-hover-bypass",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"]:not([src*="purpose=webviewView"])',
    }),
  );
  await gesture({
    id: "cukii-sidebar-contextmenu",
    selector:
      'iframe[src*="extensionId=cukii.cukii-vscode"][src*="purpose=webviewView"]',
    match: { tag: "button", titleExact: "привет - продолжим?" },
    action: "click",
    button: "right",
    postcondition: {
      kind: "becomes-visible",
      match: { tag: "button", textExact: "Resume session" },
    },
  });
  states.push(
    await captureState({
      id: "cukii-sidebar-context-menu",
      selector:
        'iframe[src*="extensionId=cukii.cukii-vscode"][src*="purpose=webviewView"]',
      activityLabel: "Cukii",
    }),
  );
  await escape("cukii-close-context-menu");
  await assertVisibleState(
    "cukii-context-menu-closed",
    'iframe[src*="extensionId=cukii.cukii-vscode"][src*="purpose=webviewView"]',
    { tag: "button", textExact: "Resume session" },
    false,
  );
} catch (error) {
  failure =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) };
} finally {
  for (const search of normalizedSearches.toReversed()) {
    if (!search.originalValue) continue;
    await ensureActivity(search.activityLabel, search.selector).catch(() => {});
    await replaceVisibleSearchValue(
      `${search.id}-restore`,
      search.selector,
      search.originalValue,
    ).catch(() => {});
  }
  if (initialWorkbench.activeActivity) {
    const active = await page
      .locator(".activitybar .action-item.checked > a.action-label")
      .first()
      .getAttribute("aria-label")
      .catch(() => null);
    if (active !== initialWorkbench.activeActivity) {
      await page
        .locator(
          `a.action-label[aria-label="${initialWorkbench.activeActivity}"]`,
        )
        .first()
        .click()
        .catch(() => {});
      await page.waitForTimeout(300);
    }
  }
  if (initialWorkbench.focusedEditorResource) {
    await page
      .locator(
        `.tab[data-resource-name="${initialWorkbench.focusedEditorResource}"]`,
      )
      .click()
      .catch(() => {});
    await page.waitForTimeout(250);
  }
}

const finalWorkbenchState = await page.evaluate(() => ({
  activeActivity:
    document
      .querySelector(".activitybar .action-item.checked > a.action-label")
      ?.getAttribute("aria-label") ?? null,
  focusedEditorResource:
    document
      .querySelector(".editor-group-container.active .tab.active.selected")
      ?.getAttribute("data-resource-name") ?? null,
}));
const finalTargets = await listTargets(endpoint);
const finalWorkbench = finalTargets.find(
  (target) => target.id === workbenchTarget.id,
);
const codeCli =
  process.env.CUKII_CODE_CLI ??
  (process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA ?? "",
        "Programs",
        "Microsoft VS Code",
        "bin",
        "code.cmd",
      )
    : "code");
const runCode = (arguments_) =>
  process.platform === "win32"
    ? execFileSync(
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.join(toolDirectory, "invoke-code.ps1"),
          codeCli,
          ...arguments_,
        ],
        { encoding: "utf8" },
      )
    : execFileSync(codeCli, arguments_, { encoding: "utf8" });
const cliVersion = runCode(["--version"]).trim().split(/\r?\n/u);
const installedExtensions = runCode(["--list-extensions", "--show-versions"])
  .trim()
  .split(/\r?\n/u)
  .filter((line) =>
    /^(anthropic\.claude-code|cukii\.cukii-vscode)@/iu.test(line),
  );
const resourcesMatchLocalCli =
  states.length > 0 &&
  states.every((state) =>
    installedExtensions.some(
      (line) =>
        line.toLowerCase() ===
        `${state.resourceEvidence.identity}@${state.resourceEvidence.version}`.toLowerCase(),
    ),
  );
const oracleScriptSha256 = sha256(await readFile(new URL(import.meta.url)));
const receipt = {
  schemaVersion: 2,
  oracle: "trusted-playwright-raw-cdp-vscode-live-webview",
  oracleScript: {
    path: new URL(import.meta.url).pathname,
    sha256: oracleScriptSha256,
  },
  runId,
  runDirectory,
  status: failure ? "FAIL" : "CAPTURED",
  failure,
  environment: {
    endpoint,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    hostname: os.hostname(),
    processPid: process.pid,
    vscodeCli: {
      executable: codeCli,
      version: cliVersion[0],
      commit: cliVersion[1],
      arch: cliVersion[2],
    },
    installedExtensions,
    workbench: initialWorkbench,
    workbenchTarget: {
      id: workbenchTarget.id,
      type: workbenchTarget.type,
      url: workbenchTarget.url,
      title: workbenchTarget.title,
    },
  },
  invariants: {
    uniqueImmutableRunDirectory: true,
    exactOuterInnerTupleBeforeAndAfter: !failure,
    atomicOuterInnerDomAndViewportBeforeAndAfter: !failure,
    rawPhysicalWorkbenchFrameCroppedByMeasuredScale: !failure,
    fullPhysicalFramesPersisted:
      !failure && states.every((state) => Boolean(state.fullScreenshotFile)),
    visibleInteractiveRequiresViewportIntersectionAndHitTest: !failure,
    installedResourceAndManifestHashesCaptured:
      !failure && resourcesMatchLocalCli,
    semanticPostconditionsPassed:
      !failure && assertions.length >= 12 && assertions.every((item) => item.pass),
    sameWorkbenchTargetAliveAfterRun: Boolean(finalWorkbench),
    originalActivityRestored:
      finalWorkbenchState.activeActivity === initialWorkbench.activeActivity,
    originalEditorGroupRestored:
      finalWorkbenchState.focusedEditorResource ===
      initialWorkbench.focusedEditorResource,
  },
  states,
  interactions,
  assertions,
};
await writeFile(
  path.join(runDirectory, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  { flag: "wx" },
);
workbenchClient.close();
await browser.close();
process.stdout.write(
  `${JSON.stringify({ status: receipt.status, runId, runDirectory, invariants: receipt.invariants, states: states.map((state) => state.id), failure }, null, 2)}\n`,
);
if (
  failure ||
  Object.values(receipt.invariants).some((value) => value !== true)
)
  process.exitCode = 2;
