import { CdpClient, listTargets } from "./cdp-client.mjs";

const extensionId = process.argv[2] ?? "Anthropic.claude-code";
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const target = (await listTargets(endpoint)).find(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`) &&
    !candidate.url.includes("purpose=webviewView"),
);
if (!target) throw new Error(`${extensionId}: editor target missing`);

const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `JSON.stringify((() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      if (!doc) return null;
      const filter = [...doc.querySelectorAll("input")].find((element) =>
        element.placeholder?.includes("Filter actions"),
      );
      const menu = filter?.parentElement?.parentElement?.parentElement;
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
      };
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          text: (element.innerText ?? element.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 500),
          title: element.getAttribute("title"),
          aria: element.getAttribute("aria-label"),
          role: element.getAttribute("role"),
          value: element.value ?? null,
          html: element.outerHTML.slice(0, 2_000),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          style: {
            color: style.color,
            backgroundColor: style.backgroundColor,
            borderColor: style.borderColor,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            padding: style.padding,
            borderRadius: style.borderRadius,
          },
        };
      };
      return {
        bodyText: doc.body.innerText,
        menu: menu && visible(menu) ? describe(menu) : null,
        controls: [...doc.querySelectorAll("button, input, [role='slider'], [role='menuitem'], [role='switch']")]
          .filter(visible)
          .map(describe),
      };
    })())`,
  });
  process.stdout.write(`${result.result.value}\n`);
} finally {
  client.close();
}
