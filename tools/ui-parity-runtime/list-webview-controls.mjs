import { CdpClient, listTargets } from "./cdp-client.mjs";

const extensionId = process.argv[2];
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
if (!extensionId)
  throw new Error("usage: list-webview-controls.mjs <extensionId>");
const targets = (await listTargets(endpoint)).filter(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`),
);
for (const target of targets) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    const response = await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
        return [...(doc?.querySelectorAll("button, [role='button'], [role='slider'], [role='switch']") ?? [])]
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          })
          .map((element) => ({
            tag: element.tagName,
            text: (element.innerText ?? element.textContent ?? "").trim().replace(/\\s+/g, " ").slice(0, 100),
            aria: element.getAttribute("aria-label"),
            title: element.title,
          })).slice(0, 100);
      })()`,
    });
    if (response.result.value?.length) {
      process.stdout.write(
        `${JSON.stringify({ targetId: target.id, controls: response.result.value }, null, 2)}\n`,
      );
    }
  } finally {
    client.close();
  }
}
