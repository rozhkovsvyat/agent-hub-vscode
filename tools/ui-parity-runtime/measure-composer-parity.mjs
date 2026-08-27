import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const vendors = ["Anthropic.claude-code", "cukii.cukii-vscode"];
const targets = await listTargets(endpoint);
const output = {};

for (const extensionId of vendors) {
  const target = targets.find((candidate) => {
    if (candidate.type !== "iframe") return false;
    const url = new URL(candidate.url);
    return url.searchParams.get("extensionId") === extensionId &&
      url.searchParams.get("purpose") !== "webviewView";
  });
  if (!target) throw new Error(`${extensionId}: editor target not found`);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `JSON.stringify((() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      if (!doc) throw new Error("active-frame unavailable");
      const candidates = [...doc.querySelectorAll("button")].filter((element) => element.title === "Add");
      const add = candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit && (hit === element || element.contains(hit));
      });
      if (!add) throw new Error("visible Add button not found");
      const menu = [...doc.querySelectorAll("button")].find((element) =>
        element.title === "Show command menu (/)" && element.getBoundingClientRect().width > 0
      );
      if (!menu) throw new Error("visible command-menu button not found");
      const describeControl = (element) => ({
        tag: element.tagName,
        className: String(element.className?.baseVal ?? element.className ?? ""),
        text: (element.textContent ?? "").trim(),
        html: element.outerHTML.slice(0, 2400),
        rect: element.getBoundingClientRect().toJSON(),
        children: [...element.querySelectorAll("*")].map((child) => ({
          tag: child.tagName,
          className: String(child.className?.baseVal ?? child.className ?? ""),
          text: (child.textContent ?? "").trim(),
          rect: child.getBoundingClientRect().toJSON(),
          style: {
            display: getComputedStyle(child).display,
            lineHeight: getComputedStyle(child).lineHeight,
            border: getComputedStyle(child).border,
            transform: getComputedStyle(child).transform,
          },
        })),
      });
      const nodes = [];
      let current = add;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        const rect = current.getBoundingClientRect();
        const style = getComputedStyle(current);
        nodes.push({
          depth,
          tag: current.tagName,
          className: current.className,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          padding: style.padding,
          margin: style.margin,
          gap: style.gap,
          border: style.border,
          boxSizing: style.boxSizing,
          minHeight: style.minHeight,
        });
      }
      return {
        viewport: { width: innerWidth, height: innerHeight },
        controls: { add: describeControl(add), menu: describeControl(menu) },
        nodes,
      };
    })())`,
  });
  client.close();
  output[extensionId] = JSON.parse(result.result.value);
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
