import { CdpClient, listTargets } from "./cdp-client.mjs";

const extensionId = process.argv[2] ?? "Anthropic.claude-code";
const sidebar = process.argv[3] === "sidebar";
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const target = (await listTargets(endpoint)).find(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`) &&
    candidate.url.includes("purpose=webviewView") === sidebar,
);
if (!target) throw new Error(`${extensionId}: editor target missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
const result = await client.send("Runtime.evaluate", {
  returnByValue: true,
  expression: `JSON.stringify((() => {
    const doc = document.querySelector("#active-frame")?.contentDocument;
    return [...doc.querySelectorAll("input, button, [role], [contenteditable='true'], .cukii-input-box, .cukii-editor-stack")].map((element) => {
      const rect = element.getBoundingClientRect();
      const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const isProbeContainer = element.matches(".cukii-input-box, .cukii-editor-stack");
      if (!isProbeContainer && (!hit || (hit !== element && !element.contains(hit)))) return null;
      return {
        tag: element.tagName,
        text: (element.innerText ?? element.textContent ?? "").trim().slice(0, 100),
        placeholder: element.getAttribute("placeholder"),
        value: element.value ?? null,
        aria: element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
        title: element.getAttribute("title"),
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        style: {
          background: getComputedStyle(element).backgroundColor,
          color: getComputedStyle(element).color,
          padding: getComputedStyle(element).padding,
        },
      };
    }).filter(Boolean);
  })())`,
});
client.close();
process.stdout.write(`${result.result.value}\n`);
