import { CdpClient, listTargets } from "./cdp-client.mjs";

const [extensionId, needle] = process.argv.slice(2);
const sidebar = process.argv.includes("--sidebar");
const rightClick = process.argv.includes("--right");
if (!extensionId || !needle)
  throw new Error(
    "usage: click-webview-control.mjs <extensionId> <aria/title/text>",
  );
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const targets = (await listTargets(endpoint)).filter(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`) &&
    candidate.url.includes("purpose=webviewView") === sidebar,
);
for (const target of targets) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  const response = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument;
      const candidates = [...(doc?.querySelectorAll("button") ?? [])];
      const matches = candidates.filter((button) => [
        button.getAttribute("aria-label"),
        button.title,
        (button.innerText ?? button.textContent ?? "").trim(),
      ].includes(${JSON.stringify(needle)}));
      if (matches.length !== 1) return { matches: matches.length };
      if (${JSON.stringify(rightClick)}) {
        const rect = matches[0].getBoundingClientRect();
        matches[0].dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      } else {
        matches[0].click();
      }
      return { matches: 1 };
    })()`,
  });
  client.close();
  if (response.result.value?.matches === 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    process.stdout.write(
      `${JSON.stringify({ status: "CLICKED", targetId: target.id })}\n`,
    );
    process.exit(0);
  }
}
throw new Error(`${extensionId}: unique control ${needle} not found`);
