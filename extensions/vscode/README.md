<div align="center">

![Cukii](media/icon.png)

<h1 align="center">Cukii</h1>

**One workspace for every AI vendor you already pay for**

</div>

Cukii puts the command-line agents you use — Claude Code, Codex, Qwen, Grok, Cursor, Kimi — behind a single chat panel inside VS Code. No per-vendor terminal juggling, no copied API keys, no second UI to learn: open the panel, pick a model, talk to it.

## What you get

- **One composer, many vendors.** Switch between Claude, OpenAI Codex, Alibaba Qwen, xAI Grok, Cursor and Moonshot Kimi from the model picker, with a `Best / All` toggle and a per-session effort control.
- **Accounts that log themselves in.** _Manage accounts_ installs each vendor CLI and opens its sign-in page in your browser; Cukii picks the session up on its own and shows a single connected / not-connected dot per vendor.
- **Sessions that survive.** Interrupted runs, remote SSH windows and restored history come back where you left them.
- **Long answers stay readable.** Sticky user messages fold to a single line while you scroll, and unfold on demand.
- **Bug reports in one click.** Send a sanitised report about a stuck or wrong session straight to the team's board, with screenshots and diagnostics attached.
- **Remote-SSH ready.** The extension runs on the remote host, so your agents work against the machine that has your code.

## Getting started

1. Install the extension and open **Cukii** from the activity bar (or run _Cukii: Open in New Window_).
2. Open **Manage accounts…** from the composer menu and press **Install** for the vendor you own, then **Log in** — the browser opens, you sign in, the row turns connected.
3. Pick a model in the composer and send your first message with `Enter`.

## Requirements

- VS Code 1.70 or newer
- Node.js 20 or newer on the machine that runs the agents
- At least one vendor CLI (Cukii can install it for you from _Manage accounts_)

## Feedback

Something stuck or answered wrongly? Use **Report a bug** in the session — it reaches the team with everything needed to reproduce. Issues and source live in the [repository](https://github.com/rozhkovsvyat/agent-hub-vscode).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
