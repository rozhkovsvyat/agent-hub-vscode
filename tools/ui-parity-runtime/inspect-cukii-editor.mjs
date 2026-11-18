import { CdpClient, listTargets } from "./cdp-client.mjs";

const targetId = process.argv[2];
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
const target = (await listTargets(endpoint)).find(
  (candidate) => candidate.id === targetId,
);
if (!target) throw new Error(`Target ${targetId} is missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const response = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      const fields = [...(doc?.querySelectorAll("textarea, input, [contenteditable='true']") ?? [])]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((element) => ({
          tag: element.tagName,
          placeholder: element.getAttribute("placeholder"),
          aria: element.getAttribute("aria-label"),
          role: element.getAttribute("role"),
          className: element.className,
          value: element.value ?? element.textContent,
        }));
      const bodyText = doc?.body?.innerText ?? "";
      return {
        fields,
        bodyTail: bodyText.slice(-2500),
        sendVisible: Boolean(doc?.querySelector('button[aria-label="Send message"]')),
        stopVisible: [...(doc?.querySelectorAll("button") ?? [])].some((element) =>
          [element.getAttribute("aria-label"), element.title, element.innerText]
            .filter(Boolean).join(" ").toLowerCase().includes("stop") &&
          element.getBoundingClientRect().width > 0
        ),
      };
    })()`,
  });
  process.stdout.write(`${JSON.stringify(response.result.value, null, 2)}\n`);
} finally {
  client.close();
}
