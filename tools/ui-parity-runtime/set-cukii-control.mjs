import { CdpClient, listTargets } from "./cdp-client.mjs";

const [targetId, control, value] = process.argv.slice(2);
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
const effortLevels = ["low", "medium", "high", "xhigh", "max", "ultra"];
if (!targetId || !["effort", "speed", "thinking"].includes(control)) {
  throw new Error(
    "usage: set-cukii-control.mjs <targetId> <effort level|speed standard|fast|thinking on|off>",
  );
}
const target = (await listTargets(endpoint)).find(
  (candidate) => candidate.id === targetId,
);
if (!target) throw new Error(`Target ${targetId} is missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      if (${JSON.stringify(control)} === "speed") {
        const button = doc?.querySelector('[data-testid="cukii-speed-toggle"]');
        if (!button) return { status: "MISSING" };
        const current = button.getAttribute("aria-checked") === "true" ? "fast" : "standard";
        if (current !== ${JSON.stringify(value)}) button.click();
        return { status: "SET", before: current };
      }
      if (${JSON.stringify(control)} === "thinking") {
        const button = doc?.querySelector('[data-testid="cukii-thinking-toggle"]');
        if (!button) return { status: "MISSING" };
        const current = button.getAttribute("aria-checked") === "true" ? "on" : "off";
        if (current !== ${JSON.stringify(value)}) button.click();
        return { status: "SET", before: current };
      }
      const slider = doc?.querySelector('[data-testid="cukii-effort-slider"]');
      if (!slider) return { status: "MISSING" };
      const levels = ${JSON.stringify(effortLevels)};
      const index = levels.indexOf(${JSON.stringify(value)});
      if (index < 0) return { status: "INVALID" };
      const box = slider.getBoundingClientRect();
      return {
        status: "READY",
        x: box.left + 9 + index * ((box.width - 18) / (levels.length - 1)),
        y: box.top + box.height / 2,
      };
    })()`,
  });
  if (result.result.value?.status === "READY") {
    const { x, y } = result.result.value;
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const receipt = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      const slider = doc?.querySelector('[data-testid="cukii-effort-slider"]');
      const speed = doc?.querySelector('[data-testid="cukii-speed-toggle"]');
      const thinking = doc?.querySelector('[data-testid="cukii-thinking-toggle"]');
      const filter = [...(doc?.querySelectorAll("input") ?? [])].find((element) =>
        element.placeholder?.includes("Filter actions") && element.getBoundingClientRect().width > 0
      );
      return {
        menuOpen: Boolean(filter),
        effort: slider?.getAttribute("aria-valuetext") ?? null,
        speed: speed?.getAttribute("aria-checked") === "true" ? "fast" : "standard",
        thinking: thinking
          ? thinking.getAttribute("aria-checked") === "true" ? "on" : "off"
          : "unavailable",
      };
    })()`,
  });
  process.stdout.write(
    `${JSON.stringify({ action: result.result.value, receipt: receipt.result.value })}\n`,
  );
} finally {
  client.close();
}
