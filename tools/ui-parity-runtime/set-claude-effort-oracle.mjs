import { CdpClient, listTargets } from "./cdp-client.mjs";

const fraction = Number(process.argv[2]);
if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
  throw new Error("Usage: set-claude-effort-oracle.mjs <fraction 0..1>");
}
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const target = (await listTargets(endpoint)).find(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes("extensionId=Anthropic.claude-code") &&
    !candidate.url.includes("purpose=webviewView"),
);
if (!target) throw new Error("Claude editor target missing");
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      const control = doc?.querySelector('button[title="Click or drag to set effort level"]');
      if (!control) return { status: "MISSING" };
      const rect = control.getBoundingClientRect();
      const clientX = rect.left + ${fraction} * rect.width;
      const clientY = rect.top + rect.height / 2;
      return { status: "READY", clientX, clientY };
    })()`,
  });
  if (result.result.value?.status === "READY") {
    const { clientX: x, clientY: y } = result.result.value;
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
  await new Promise((resolve) => setTimeout(resolve, 300));
  const label = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `document.querySelector("#active-frame")?.contentDocument?.body?.innerText.match(/Effort\\s*\\(([^)]+)\\)/)?.[1] ?? null`,
  });
  process.stdout.write(
    `${JSON.stringify({ ...result.result.value, status: result.result.value?.status === "READY" ? "CLICKED" : result.result.value?.status, label: label.result.value })}\n`,
  );
} finally {
  client.close();
}
