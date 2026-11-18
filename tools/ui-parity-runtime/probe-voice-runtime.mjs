import { CdpClient, listTargets } from "./cdp-client.mjs";

const extensionId = process.argv[2] ?? "cukii.cukii-vscode";
const aria = process.argv[3] ?? "Start voice input";
const target = (await listTargets("http://127.0.0.1:9222")).find(
  (candidate) =>
    candidate.type === "iframe" &&
    candidate.url.includes(`extensionId=${extensionId}`) &&
    !candidate.url.includes("purpose=webviewView"),
);
if (!target) throw new Error(`${extensionId}: editor target missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
const evaluate = async (expression) =>
  (
    await client.send("Runtime.evaluate", {
      returnByValue: true,
      expression,
    })
  ).result.value;
const before = await evaluate(`(() => {
  const doc = document.querySelector("#active-frame")?.contentDocument;
  const button = [...(doc?.querySelectorAll("button") ?? [])].find(
    (candidate) => candidate.getAttribute("aria-label") === ${JSON.stringify(aria)},
  );
  if (!button) return null;
  button.click();
  return { aria: button.getAttribute("aria-label"), title: button.title };
})()`);
await new Promise((resolve) => setTimeout(resolve, 600));
const after = await evaluate(`(() => {
  const doc = document.querySelector("#active-frame")?.contentDocument;
  return [...(doc?.querySelectorAll("button") ?? [])]
    .filter((button) => /voice|microphone|dictation/i.test(
      [button.getAttribute("aria-label"), button.title].filter(Boolean).join(" "),
    ))
    .map((button) => ({
      aria: button.getAttribute("aria-label"),
      title: button.title,
      pressed: button.getAttribute("aria-pressed"),
      background: getComputedStyle(button).backgroundColor,
    }));
})()`);
client.close();
process.stdout.write(`${JSON.stringify({ extensionId, before, after }, null, 2)}\n`);
