import { CdpClient, listTargets } from "./cdp-client.mjs";

const [extensionId, needle] = process.argv.slice(2);
const sidebar = process.argv.includes("--sidebar");
const rightClick = process.argv.includes("--right");
const anyElement = process.argv.includes("--any");
const containsText = process.argv.includes("--contains");
const useLastMatch = process.argv.includes("--last");
const targetFlagIndex = process.argv.indexOf("--target");
const requestedTargetId =
  targetFlagIndex >= 0 ? process.argv[targetFlagIndex + 1] : undefined;
if (!extensionId || !needle)
  throw new Error(
    "usage: click-webview-control.mjs <extensionId> <aria/title/text>",
  );
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const targets = (await listTargets(endpoint)).filter(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`) &&
    candidate.url.includes("purpose=webviewView") === sidebar &&
    (!requestedTargetId || candidate.id === requestedTargetId),
);
for (const target of targets) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  const response = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      const candidates = [...(doc?.querySelectorAll(${JSON.stringify(anyElement ? "*" : "button")}) ?? [])];
      const normalize = (value) => (value ?? "").replace(/\s+/g, " ").trim();
      const wanted = normalize(${JSON.stringify(needle)});
      const matches = candidates.filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && [
          button.getAttribute("aria-label"),
          button.title,
          button.innerText ?? button.textContent ?? "",
        ].some((value) => {
          const normalized = normalize(value);
          return ${JSON.stringify(containsText)}
            ? normalized.includes(wanted)
            : normalized === wanted;
        });
      });
      const leaves = matches.filter((candidate) =>
        !matches.some((other) => other !== candidate && candidate.contains(other)),
      );
      if (leaves.length !== 1 && !(${JSON.stringify(useLastMatch)} && leaves.length > 0))
        return { matches: leaves.length };
      const selected = ${JSON.stringify(useLastMatch)} ? leaves.at(-1) : leaves[0];
      if (${JSON.stringify(rightClick)}) {
        const rect = selected.getBoundingClientRect();
        selected.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      } else {
        selected.click();
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
