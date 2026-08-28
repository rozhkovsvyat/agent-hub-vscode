import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const targets = await listTargets(endpoint);
const output = [];

for (const target of targets.filter((item) => item.type === "iframe")) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  const result = await client.send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const doc = document.querySelector("#active-frame")?.contentDocument ?? document;
      const win = doc.defaultView ?? window;
      const style = (element) => {
        if (!element) return null;
        const computed = win.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          id: element.id,
          className: String(element.className).slice(0, 180),
          backgroundColor: computed.backgroundColor,
          color: computed.color,
          box: { x: box.x, y: box.y, width: box.width, height: box.height }
        };
      };
      const candidates = [...doc.querySelectorAll("*")].filter((element) =>
        /sessionLayout|messagesContainer|chatContainer|sidebar|input|composer/i.test(String(element.className))
      );
      const rootStyle = win.getComputedStyle(doc.documentElement);
      return {
        text: (doc.body?.innerText ?? "").slice(0, 250),
        body: style(doc.body),
        root: style(doc.documentElement),
        variables: {
          vscodeEditor: rootStyle.getPropertyValue("--vscode-editor-background").trim(),
          vscodeSidebar: rootStyle.getPropertyValue("--vscode-sideBar-background").trim(),
          primary: rootStyle.getPropertyValue("--app-primary-background").trim(),
          secondary: rootStyle.getPropertyValue("--app-secondary-background").trim()
        },
        candidates: candidates.slice(0, 80).map(style)
      };
    })())`,
    returnByValue: true,
  });
  output.push({
    targetId: target.id,
    extensionId: new URL(target.url).searchParams.get("extensionId"),
    runtime: JSON.parse(result.result.value),
  });
  client.close();
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
