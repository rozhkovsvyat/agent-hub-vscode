import { CdpClient, listTargets } from "./cdp-client.mjs";

const [targetId, message] = process.argv.slice(2);
const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9444";
if (!targetId || !message)
  throw new Error("usage: send-cukii-message.mjs <targetId> <message>");
const target = (await listTargets(endpoint)).find(
  (candidate) => candidate.id === targetId,
);
if (!target) throw new Error(`Target ${targetId} is missing`);
const client = new CdpClient(target.webSocketDebuggerUrl);
await client.connect();
try {
  const focused = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      const editor = [...(doc?.querySelectorAll("[contenteditable='true']") ?? [])].find((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
      if (!editor) return false;
      editor.focus();
      return true;
    })()`,
  });
  if (!focused.result.value) throw new Error("Visible Cukii editor is missing");
  await client.send("Input.insertText", { text: message });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const send = await client.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      const editor = [...doc.querySelectorAll("[contenteditable='true']")].find((element) =>
        element.getBoundingClientRect().width > 0
      );
      const button = doc.querySelector('button[aria-label="Send message"]');
      const receipt = {
        editorText: editor?.innerText ?? null,
        sendDisabled: Boolean(button?.disabled),
      };
      if (!button || button.disabled) return { status: "NOT_READY", ...receipt };
      button.click();
      return { status: "SENT", ...receipt };
    })()`,
  });
  process.stdout.write(`${JSON.stringify(send.result.value)}\n`);
} finally {
  client.close();
}
