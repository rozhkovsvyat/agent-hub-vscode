import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
const requestedTargetId = process.argv[2];
const candidates = (await listTargets(endpoint)).filter(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes("extensionId=cukii.cukii-vscode") &&
    !candidate.url.includes("purpose=webviewView"),
);
const targets = requestedTargetId
  ? candidates.filter((candidate) => candidate.id === requestedTargetId)
  : candidates;

for (const target of targets) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
        const visible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
        };
        const filter = [...(doc?.querySelectorAll("input") ?? [])].find(
          (element) => element.placeholder?.includes("Filter actions") && visible(element),
        );
        if (!filter) return null;
        const rect = (element) => {
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height };
        };
        const control = (element) => element && ({
          tag: element.tagName,
          text: (element.innerText ?? element.textContent ?? "").trim().replace(/\\s+/g, " "),
          ariaLabel: element.getAttribute("aria-label"),
          ariaValueText: element.getAttribute("aria-valuetext"),
          ariaChecked: element.getAttribute("aria-checked"),
          disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
          rect: rect(element),
          style: {
            color: getComputedStyle(element).color,
            backgroundColor: getComputedStyle(element).backgroundColor,
            borderRadius: getComputedStyle(element).borderRadius,
            transition: getComputedStyle(element).transition,
          },
          children: [...element.children].map((child) => ({
            className: child.className,
            rect: rect(child),
            backgroundColor: getComputedStyle(child).backgroundColor,
            borderRadius: getComputedStyle(child).borderRadius,
            transition: getComputedStyle(child).transition,
          })),
        });
        const all = [...doc.querySelectorAll("button, [role='slider'], [role='switch']")].filter(visible);
        const byAria = (needle) => all.find((element) => element.getAttribute("aria-label")?.includes(needle));
        const byText = (needle) => all.find((element) => (element.innerText ?? element.textContent ?? "").trim().includes(needle));
        const menu = filter.closest("[data-testid='commands-menu']") ?? filter.parentElement?.parentElement?.parentElement;
        return {
          targetId: ${JSON.stringify(target.id)},
          menu: menu ? { rect: rect(menu), text: menu.innerText.trim().replace(/\\s+/g, " ").slice(0, 800) } : null,
          effort: control(byAria("Effort") ?? byText("Effort")),
          fast: control(byAria("Fast mode") ?? byText("Fast mode")),
          thinking: control(byAria("Thinking") ?? byText("Thinking")),
        };
      })()`,
    });
    if (response.result.value) {
      process.stdout.write(
        `${JSON.stringify(response.result.value, null, 2)}\n`,
      );
      process.exit(0);
    }
  } finally {
    client.close();
  }
}

throw new Error(
  "Cukii command menu is not visible in the requested editor target",
);
