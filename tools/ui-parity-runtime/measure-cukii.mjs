import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const target = (await listTargets(endpoint)).find((candidate) => {
  if (candidate.type !== "iframe") return false;
  const url = new URL(candidate.url);
  return url.searchParams.get("extensionId") === "cukii.cukii-vscode" &&
    url.searchParams.get("purpose") !== "webviewView";
});
if (!target) throw new Error("Cukii editor target not found");

const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
await client.send("Runtime.enable");
const result = await client.send("Runtime.evaluate", {
  returnByValue: true,
  expression: `JSON.stringify((() => {
    const doc = document.querySelector("#active-frame")?.contentDocument;
    if (!doc) throw new Error("active-frame unavailable");
    const selectors = [
      ".cukii-main-input-shell",
      ".cukii-input-box",
      ".cukii-editor-stack",
      ".cukii-input-footer",
      ".cukii-command-menu",
      ".cukii-menu-filter",
      ".cukii-model-picker",
      '[aria-label="Attach"]',
      '[aria-label="Commands and model"]',
      '.cukii-permission-button'
    ];
    return Object.fromEntries(selectors.map((selector) => {
      const matches = [...doc.querySelectorAll(selector)];
      const element = matches.find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const point = rect.width > 0 && rect.height > 0
          ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
          : null;
        const hit = point ? doc.elementFromPoint(point.x, point.y) : null;
        return hit && (hit === candidate || candidate.contains(hit));
      }) ?? matches.at(-1);
      if (!element) return [selector, null];
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [selector, {
        matches: matches.length,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        display: style.display,
        position: style.position,
        padding: style.padding,
        margin: style.margin,
        gap: style.gap,
        background: style.backgroundColor,
        border: style.border,
        borderRadius: style.borderRadius,
        fontSize: style.fontSize,
      }];
    }));
  })())`,
});
client.close();
process.stdout.write(`${JSON.stringify(JSON.parse(result.result.value), null, 2)}\n`);
