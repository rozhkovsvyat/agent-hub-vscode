#!/usr/bin/env node
// Live acceptance driver for an INSTALLED Cukii Chat VSIX in a separate,
// throwaway VS Code profile, over the Chrome DevTools Protocol. Born from the
// 2026-10-02 acceptance runs; every rule below cost a wrong result once:
//
//  - The CDP port must be free: a stale headless Chrome on the same port
//    answered for hours and VS Code silently failed to bind.
//  - Always pass --disable-workspace-trust (also when re-opening a window of a
//    running instance): in Restricted Mode Cukii is off and tabs stay blank.
//  - Only evaluate in a VISIBLE webview with a transcript: hidden webviews do
//    not run requestAnimationFrame or scroll-driven animations, so awaits hang
//    and fold geometry never moves. Bring the window to front first.
//  - Submit with real key events (Input.insertText + Enter), not el.click().
//  - The picker lists Opus/Fable/Kimi/Grok both under their vendor and under
//    "Cursor"; pick by group, or the run silently spends Cursor quota.
//  - Screenshot the smoke window only (Page.captureScreenshot), never the
//    owner's screen.
//  - The chat history is NOT isolated either: it is the owner's
//    ~/.cukii/history.sqlite3, and test chats piled up in his session list
//    (card 44a9280d). Close with `close --port N --profile P`, which first runs
//    `cleanup`: it deletes, through the extension's own history/delete, only
//    the sessions whose workspace is this profile's ws folder.
//  - The profile is isolated, the vendor CLIs are NOT: their configs (incl. the
//    Cukii Box memory MCP) are the owner's. Never ask an agent to "remember"
//    in a test prompt — Kimi stored a test codeword in the owner's memory —
//    and memory_grep your test markers afterwards.
//
// Usage (all commands print one JSON line):
//   node cukii-smoke.mjs launch --vsix <file.vsix> [--profile /tmp/cukii-smoke-x]
//   node cukii-smoke.mjs new-session --port N
//   node cukii-smoke.mjs model --port N --name "Kimi K3" [--group Anthropic|Cursor|MoonshotAI|OpenAI]
//   node cukii-smoke.mjs send --port N --text "..." [--tab "substring of the tab transcript"]
//   node cukii-smoke.mjs wait-idle --port N [--tab ...] [--timeout 300]
//   node cukii-smoke.mjs stop --port N [--tab ...]
//   node cukii-smoke.mjs probe --port N --js "<expression>" [--tab ...]
//   node cukii-smoke.mjs sidebar-probe --port N --js "<expression, truthy where found>"
//   node cukii-smoke.mjs shot --port N --out /tmp/x.png
//   node cukii-smoke.mjs cleanup --port N --profile /tmp/cukii-smoke-x
//   node cukii-smoke.mjs close [--port N] --profile /tmp/cukii-smoke-x
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(3);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = (value) => {
  console.log(JSON.stringify(value));
  process.exit(0);
};
const fail = (message) => {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
};

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).filter(Boolean);
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const contexts = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const call = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { ws, call, contexts };
}

async function workbench(port) {
  const page = (await targets(port)).find((t) => t.type === "page" && t.url.includes("workbench"));
  if (!page) fail("no workbench page");
  return connect(page.webSocketDebuggerUrl);
}

/** The visible Cukii transcript context, optionally the tab containing `tab`. */
async function cukiiTab(port, tab) {
  const wb = await workbench(port);
  await wb.call("Page.bringToFront");
  wb.ws.close();
  for (const target of (await targets(port)).filter((t) => t.type === "iframe")) {
    const c = await connect(target.webSocketDebuggerUrl);
    await c.call("Runtime.enable");
    await sleep(300);
    for (const ctx of c.contexts) {
      const ev = async (expression) =>
        (await c.call("Runtime.evaluate", { contextId: ctx.id, expression, returnByValue: true, awaitPromise: true }))
          .result?.result?.value;
      const ok = await ev(`(() => { const t = document.querySelector(".cukii-transcript"); return !!t && t.getBoundingClientRect().width > 0 && ${tab ? `t.innerText.includes(${JSON.stringify(tab)})` : "true"}; })()`);
      if (ok) return { ...c, ev };
    }
    c.ws.close();
  }
  return undefined;
}

async function sidebarEval(port, expression) {
  for (const target of (await targets(port)).filter((t) => t.type === "iframe")) {
    const c = await connect(target.webSocketDebuggerUrl);
    await c.call("Runtime.enable");
    await sleep(300);
    for (const ctx of c.contexts) {
      const r = await c.call("Runtime.evaluate", { contextId: ctx.id, expression, returnByValue: true, awaitPromise: true });
      if (r.result?.result?.value) {
        c.ws.close();
        return r.result.result.value;
      }
    }
    c.ws.close();
  }
  return undefined;
}

const STREAMING = `!![...document.querySelectorAll("button")].find(b => /Stop (response|generation)/.test(b.getAttribute("aria-label") || ""))`;

async function openPanel(port) {
  const wb = await workbench(port);
  await wb.call("Page.bringToFront");
  for (let i = 0; i < 20; i++) {
    const r = await wb.call("Runtime.evaluate", {
      expression: `(() => { const c = [...document.querySelectorAll(".activitybar .action-label")].find(a => /Cukii/.test(a.getAttribute("aria-label") || "")); if (!c) return null; const b = c.getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2, c.getAttribute("aria-label")]; })()`,
      returnByValue: true,
    });
    const at = r.result?.result?.value;
    if (at) {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await wb.call("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 });
      }
      wb.ws.close();
      return at[2];
    }
    await sleep(1000);
  }
  wb.ws.close();
  return undefined;
}

const WINDOWS = process.platform === "win32";

/** `code` is a .cmd shim on Windows; Node refuses to spawn one without a shell. */
function codeArgs(list) {
  if (!WINDOWS) return ["code", list, {}];
  const quoted = list.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  return ["code.cmd", quoted, { shell: true, windowsHide: true }];
}

/**
 * Deletes, through the extension's own history/delete, every session whose
 * workspace is this profile's ws folder — nothing else in the owner's history.
 */
async function cleanupSessions(port, profile) {
  const ws = path.resolve(profile, "ws");
  const expression = `(async () => {
    if (typeof vscode === "undefined") return null;
    const ask = (messageType, data) => new Promise((resolve, reject) => {
      const messageId = "cukii-smoke-" + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { window.removeEventListener("message", on); reject(new Error(messageType + " timed out")); }, 15000);
      const on = (event) => {
        if (event.data?.messageId !== messageId) return;
        clearTimeout(timer);
        window.removeEventListener("message", on);
        const reply = event.data.data;
        reply?.status === "error" ? reject(new Error(reply.error)) : resolve(reply?.content ?? reply);
      };
      window.addEventListener("message", on);
      vscode.postMessage({ messageId, messageType, data });
    });
    const norm = (p) => String(p || "").replace(/^file:\\/\\/\\/?/i, "").replace(/\\\\/g, "/").replace(/\\/+$/, "").toLowerCase();
    const mine = norm(${JSON.stringify(ws)});
    const sessions = await ask("history/list", {});
    const own = sessions.filter((s) => { const w = norm(decodeURIComponent(s.workspaceDirectory || "")); return w === mine || w.endsWith(mine); });
    for (const s of own) await ask("history/delete", { id: s.sessionId });
    const left = (await ask("history/list", {})).filter((s) => own.some((o) => o.sessionId === s.sessionId)).length;
    return { deleted: own.length, left, titles: own.map((s) => s.title) };
  })()`;
  return sidebarEval(port, expression);
}

const cmd = process.argv[2];
const port = Number(opt("port", 0));

if (cmd === "launch") {
  const vsix = opt("vsix");
  if (!vsix || !fs.existsSync(vsix)) fail("--vsix <file> is required");
  const profile = opt("profile", `/tmp/cukii-smoke-${Date.now()}`);
  for (const dir of ["ud", "ext", "ws"]) fs.mkdirSync(path.join(profile, dir), { recursive: true });
  try {
    execFileSync("git", ["init", "-q", path.join(profile, "ws")]);
  } catch {
    /* optional */
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const base = ["--user-data-dir", path.join(profile, "ud"), "--extensions-dir", path.join(profile, "ext")];
  const [installBin, installArgs, installOpts] = codeArgs([...base, "--install-extension", vsix, "--force"]);
  execFileSync(installBin, installArgs, { env, stdio: "ignore", ...installOpts });
  const cdp = await freePort();
  const [runBin, runArgs, runOpts] = codeArgs([...base, `--remote-debugging-port=${cdp}`, "--new-window", "--disable-workspace-trust", path.join(profile, "ws")]);
  spawn(runBin, runArgs, {
    env,
    detached: true,
    stdio: "ignore",
    ...runOpts,
  }).unref();
  for (let i = 0; i < 60; i++) {
    try {
      if ((await targets(cdp)).some((t) => t.type === "page")) break;
    } catch {
      /* not up yet */
    }
    await sleep(1000);
  }
  await sleep(6000);
  // A click that lands before the workbench is ready only shows the tooltip,
  // and first activation of a fresh profile is slow: click, then wait for the
  // Cukii webview to render its session list, and retry the click.
  let panel;
  let ready = false;
  for (let attempt = 0; attempt < 3 && !ready; attempt++) {
    panel = await openPanel(cdp);
    for (let i = 0; i < 20 && !ready; i++) {
      ready = !!(await sidebarEval(cdp, `/New session/.test(document.body?.innerText || "") ? "ready" : null`).catch(() => undefined));
      if (!ready) await sleep(1000);
    }
  }
  if (!ready) fail("Cukii panel did not open");
  out({ port: cdp, profile, panel: panel ?? null, ready });
}

if (cmd === "cleanup") {
  const profile = opt("profile");
  if (!port || !profile) fail("--port and --profile are required");
  const result = await cleanupSessions(port, profile);
  if (!result) fail("no Cukii webview answered the cleanup");
  out(result);
}

if (cmd === "close") {
  const profile = opt("profile");
  if (!profile) fail("--profile is required");
  // Test chats first, while the instance can still delete them (44a9280d).
  const cleaned = port ? await cleanupSessions(port, profile).catch((e) => ({ error: String(e) })) : null;
  const ud = path.join(profile, "ud");
  let killed = 0;
  if (WINDOWS) {
    // Every Code.exe of THIS profile (main and helpers share --user-data-dir).
    const list = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
      { encoding: "utf8", windowsHide: true },
    );
    const mark = `--user-data-dir ${ud}`.toLowerCase();
    for (const line of list.split(/\r?\n/)) {
      const [pid, commandLine = ""] = line.split("\t");
      const cl = commandLine.replace(/"/g, "").toLowerCase();
      if (pid && (cl.includes(mark) || cl.includes(`--user-data-dir=${ud}`.toLowerCase()))) {
        try {
          process.kill(Number(pid));
          killed++;
        } catch {
          /* already gone with its parent */
        }
      }
    }
  } else {
    for (const line of execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      // Only the main process of THIS profile; helpers exit with it.
      if (m && m[2].includes("/MacOS/Code ") && m[2].includes(`--user-data-dir ${ud}`)) {
        process.kill(Number(m[1]));
        killed++;
      }
    }
  }
  out({ closed: killed, cleaned });
}

if (!port) fail("--port is required");

if (cmd === "new-session") {
  const r = await sidebarEval(port, `(() => { const b = [...document.querySelectorAll("button")].find(x => /New session/.test(x.innerText || "")); if (!b) return null; b.click(); return "clicked"; })()`);
  out({ newSession: r ?? null });
}

if (cmd === "sidebar-probe") {
  // The sessions navigator (with Account & usage) is its own webview.
  out({ value: (await sidebarEval(port, opt("js", "null"))) ?? null });
}

if (cmd === "shot") {
  const wb = await workbench(port);
  await wb.call("Page.bringToFront");
  const r = await wb.call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(opt("out", "/tmp/cukii-smoke.png"), Buffer.from(r.result.data, "base64"));
  out({ saved: opt("out", "/tmp/cukii-smoke.png") });
}

const tab = await cukiiTab(port, opt("tab"));
if (!tab) fail("no visible Cukii transcript" + (opt("tab") ? ` containing ${opt("tab")}` : ""));

if (cmd === "model") {
  const name = opt("name");
  const group = opt("group");
  const r = await tab.ev(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const pill = () => document.querySelector("[data-testid=cukii-model-pill]");
    pill().click(); await sleep(900);
    const all = [...document.querySelectorAll("*")];
    const leaves = all.filter((e) => (e.innerText || "").trim().startsWith(${JSON.stringify(name)} + "\\n") && !all.some((o) => o !== e && e.contains(o) && (o.innerText || "").trim().startsWith(${JSON.stringify(name)} + "\\n")) && !e.closest("[data-testid=cukii-model-pill]"));
    let pick = leaves.at(-1);
    if (${JSON.stringify(group ?? null)}) {
      const headers = all.filter((e) => e.children.length === 0 && (e.textContent || "").trim() === ${JSON.stringify(group ?? "")});
      const header = headers[0];
      pick = header ? leaves.find((l) => header.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined;
    }
    pick?.click(); await sleep(700);
    return { picked: !!pick, pill: pill()?.innerText };
  })()`);
  out(r);
}

if (cmd === "send") {
  await tab.ev(`(() => { const ed = [...document.querySelectorAll("[contenteditable=true]")].at(-1); ed.focus(); return true; })()`);
  await tab.call("Input.insertText", { text: opt("text", "") });
  await sleep(300);
  await tab.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
  await tab.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(1000);
  out({ sent: (await tab.ev(`[...document.querySelectorAll("[contenteditable=true]")].at(-1)?.innerText.trim().length ?? -1`)) === 0, streaming: await tab.ev(STREAMING) });
}

if (cmd === "wait-idle") {
  const until = Date.now() + Number(opt("timeout", 300)) * 1000;
  let streaming = true;
  while (Date.now() < until) {
    streaming = await tab.ev(STREAMING);
    if (!streaming) break;
    await sleep(2000);
  }
  out({ streaming, tail: await tab.ev(`document.querySelector(".cukii-transcript").innerText.slice(-600)`) });
}

if (cmd === "stop") {
  out({ stopped: await tab.ev(`(() => { const b = [...document.querySelectorAll("button")].find(x => /Stop (response|generation)/.test(x.getAttribute("aria-label") || "")); if (!b) return false; b.click(); return true; })()`) });
}

if (cmd === "probe") {
  out({ value: await tab.ev(opt("js", "null")) });
}

fail(`unknown command ${cmd}`);
