import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const targets = (await listTargets(endpoint)).filter(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes("extensionId=Anthropic.claude-code") &&
    !candidate.url.includes("purpose=webviewView"),
);

for (const target of targets) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const doc = document.querySelector("#active-frame")?.contentDocument;
        const visible = (element) => {
          if (!element) return false;
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden";
        };
        const filter = [...(doc?.querySelectorAll("input") ?? [])].find(
          (element) => element.placeholder?.includes("Filter actions") && visible(element),
        );
        if (!filter) return null;
        const elements = [...doc.querySelectorAll("button, input, [role='slider'], [role='switch']")].filter(visible);
        const effort = elements.find((element) =>
          [element.getAttribute("aria-label"), element.getAttribute("aria-valuetext"), element.title]
            .filter(Boolean).join(" ").toLowerCase().includes("effort"),
        ) ?? elements.find((element) => (element.parentElement?.innerText ?? "").includes("Effort ("));
        const box = (element) => {
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height };
        };
        const describe = (element) => element && ({
          tag: element.tagName,
          text: (element.innerText ?? element.textContent ?? "").trim().replace(/\\s+/g, " "),
          ariaLabel: element.getAttribute("aria-label"),
          ariaValueText: element.getAttribute("aria-valuetext"),
          rect: box(element),
          style: {
            backgroundColor: getComputedStyle(element).backgroundColor,
            borderRadius: getComputedStyle(element).borderRadius,
            padding: getComputedStyle(element).padding,
          },
          children: [...element.children].map((child) => ({
            className: child.className,
            rect: box(child),
            backgroundColor: getComputedStyle(child).backgroundColor,
            borderRadius: getComputedStyle(child).borderRadius,
          })),
        });
        return { targetId: ${JSON.stringify(target.id)}, effort: describe(effort) };
      })()`,
    });
    if (response.result.value?.effort) {
      process.stdout.write(
        `${JSON.stringify(response.result.value, null, 2)}\n`,
      );
      process.exit(0);
    }
  } finally {
    client.close();
  }
}

throw new Error("Visible Claude Effort control was not found");
