import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const vendors = ["Anthropic.claude-code", "cukii.cukii-vscode"];
const targets = await listTargets(endpoint);
const output = {};

for (const extensionId of vendors) {
  const target = targets.find((candidate) => {
    if (candidate.type !== "iframe") return false;
    const url = new URL(candidate.url);
    return (
      url.searchParams.get("extensionId") === extensionId &&
      url.searchParams.get("purpose") !== "webviewView"
    );
  });
  if (!target) throw new Error(`${extensionId}: editor target not found`);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 1,
    y: 1,
  });
  await client.send("Runtime.evaluate", {
    expression:
      'document.querySelector("#active-frame")?.contentDocument?.activeElement?.blur()',
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  let result;
  try {
    result = await client.send("Runtime.evaluate", {
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
      const menu = [...doc.querySelectorAll("button")].find((element) => {
        if (element.title !== "Show command menu (/)") return false;
        const rect = element.getBoundingClientRect();
        const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.width > 0 && rect.height > 0 && hit && (hit === element || element.contains(hit));
      });
      if (!menu) throw new Error("visible command-menu button not found");
      const extensionId = ${JSON.stringify(extensionId)};
      const isClaude = extensionId === "Anthropic.claude-code";
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return rect.width > 0 && rect.height > 0 && hit && (hit === element || element.contains(hit));
      };
      const composer = isClaude
        ? add.closest("fieldset")
        : doc.querySelector(".cukii-main-input-shell .cukii-input-box");
      const wrapper = isClaude
        ? composer?.closest(".inputWrapper_cKsPxg")
        : doc.querySelector(".cukii-main-input-shell");
      const footer = isClaude
        ? add.closest('[class*="inputFooter"]')
        : doc.querySelector(".cukii-main-input-shell .cukii-input-footer");
      const input = isClaude
        ? doc.querySelector('[aria-label="Message input"]')
        : [...doc.querySelectorAll('.cukii-main-input-shell [contenteditable="true"]')].find(visible);
      const voice = [...doc.querySelectorAll('button[aria-label="Voice dictation"]')].find(visible);
      const placeholderTarget = isClaude
        ? input
        : input?.querySelector("p.is-editor-empty:first-child");
      const describeStyle = (element, pseudo = null) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element, pseudo);
        return {
          rect: rect.toJSON(),
          background: style.backgroundColor,
          color: style.color,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          padding: style.padding,
          paddingLeft: style.paddingLeft,
          border: style.border,
          borderRadius: style.borderRadius,
          boxSizing: style.boxSizing,
          maxWidth: style.maxWidth,
          content: style.content,
        };
      };
      const describeControl = (element) => ({
        tag: element.tagName,
        className: String(element.className?.baseVal ?? element.className ?? ""),
        text: (element.textContent ?? "").trim(),
        html: element.outerHTML.slice(0, 2400),
        rect: element.getBoundingClientRect().toJSON(),
        style: describeStyle(element),
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
      const permission = isClaude
        ? [...doc.querySelectorAll("button")].find(
            (element) =>
              (element.title ?? "").includes("Claude will") && visible(element),
          )
        : [...doc.querySelectorAll("button.cukii-permission-button")].find(
            visible,
          );
      const permissionLabel = permission?.querySelector("span") ?? null;
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
          borderRadius: style.borderRadius,
          background: style.backgroundColor,
          color: style.color,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          maxWidth: style.maxWidth,
          boxSizing: style.boxSizing,
          minHeight: style.minHeight,
        });
      }
      return {
        viewport: { width: innerWidth, height: innerHeight },
        contract: {
          body: describeStyle(doc.body),
          composer: describeStyle(composer),
          wrapper: describeStyle(wrapper),
          footer: describeStyle(footer),
          input: describeStyle(input),
          placeholder: describeStyle(placeholderTarget, "::before"),
          voice: describeStyle(voice),
          inputHtml: input?.outerHTML.slice(0, 2400) ?? null,
        },
        controls: {
          add: describeControl(add),
          menu: describeControl(menu),
          permission: permission
            ? {
                ...describeControl(permission),
                label: permissionLabel
                  ? describeStyle(permissionLabel)
                  : null,
              }
            : null,
        },
        nodes,
      };
    })())`,
    });
  } finally {
    client.close();
  }
  output[extensionId] = JSON.parse(result.result.value);
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
