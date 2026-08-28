import { CdpClient, listTargets } from "./cdp-client.mjs";

const extensionId = process.argv[2] ?? "Anthropic.claude-code";
const heading = process.argv[3] ?? "Account & Usage";
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const target = (await listTargets(endpoint)).find(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`) &&
    !candidate.url.includes("purpose=webviewView"),
);
if (!target) throw new Error(`${extensionId}: editor webview target missing`);

const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      const compact = (element) => {
        const style = element.ownerDocument.defaultView.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          className: String(element.className ?? ""),
          text: (element.innerText ?? element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 240),
          box: { x: box.x, y: box.y, width: box.width, height: box.height },
          style: {
            display: style.display,
            position: style.position,
            color: style.color,
            backgroundColor: style.backgroundColor,
            border: style.border,
            borderRadius: style.borderRadius,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            padding: style.padding,
            margin: style.margin,
            gap: style.gap,
          },
        };
      };
      const exact = ${JSON.stringify(heading)};
      const leaf = [...doc.querySelectorAll("*")].find((element) =>
        element.children.length === 0 &&
        (element.textContent ?? "").replace(/\\s+/g, " ").trim() === exact
      );
      if (!leaf) return { found: false, bodyText: doc.body?.innerText ?? "" };
      const chain = [];
      let cursor = leaf;
      for (let depth = 0; cursor && cursor !== doc.body && depth < 8; depth += 1) {
        chain.push(compact(cursor));
        cursor = cursor.parentElement;
      }
      const panel = leaf.closest("[class]")?.parentElement?.parentElement ?? leaf.parentElement;
      const visible = [...doc.querySelectorAll("h1,h2,h3,button,[class]")]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          const text = (element.innerText ?? element.textContent ?? "").replace(/\\s+/g, " ").trim();
          return box.width > 0 && box.height > 0 && text &&
            ["ACCOUNT", "Auth method", "Email", "Organization", "Plan", "USAGE", "Account & Usage"].includes(text);
        })
        .map(compact);
      return { found: true, chain, visible, panel: panel ? compact(panel) : null };
    })()`,
  });
  process.stdout.write(`${JSON.stringify(result.result.value, null, 2)}\n`);
} finally {
  client.close();
}
