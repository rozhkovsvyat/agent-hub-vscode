import { CdpClient, listTargets } from "./cdp-client.mjs";

const endpoint = process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const targets = await listTargets(endpoint);
const output = [];

for (const target of targets.filter((item) => item.type === "iframe")) {
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send("Runtime.enable");
  const result = await client.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      readyState: document.readyState,
      title: document.title,
      bodyText: document.body?.innerText ?? "",
      bodyHtmlLength: document.body?.innerHTML.length ?? 0,
      childTags: [...(document.body?.children ?? [])].map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        src: element.getAttribute?.("src")
      })),
      innerFrame: (() => {
        const frame = document.querySelector("#active-frame");
        try {
          return {
            accessible: Boolean(frame?.contentDocument),
            readyState: frame?.contentDocument?.readyState,
            bodyText: frame?.contentDocument?.body?.innerText ?? "",
            bodyHtmlLength: frame?.contentDocument?.body?.innerHTML.length ?? 0,
            viewport: {
              width: frame?.contentWindow?.innerWidth,
              height: frame?.contentWindow?.innerHeight,
              dpr: frame?.contentWindow?.devicePixelRatio
            },
            frameBox: frame?.getBoundingClientRect().toJSON()
          };
        } catch (error) {
          return { accessible: false, error: String(error) };
        }
      })(),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }
    })`,
    returnByValue: true,
  });
  output.push({
    targetId: target.id,
    extensionId: new URL(target.url).searchParams.get("extensionId"),
    url: target.url,
    runtime: JSON.parse(result.result.value),
  });
  client.close();
}

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
