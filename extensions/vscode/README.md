<div align="center">

![Cukii Chat](https://raw.githubusercontent.com/rozhkovsvyat/agent-hub-vscode/cukii/trunk/extensions/vscode/media/icon.png)

<h1 align="center">Cukii Chat</h1>

**One chat for every AI coding CLI you already pay for**

</div>

Cukii Chat puts the command-line agents you use — Claude Code, Codex, Qwen, Grok, Cursor, Kimi — behind a single chat panel inside VS Code. No per-vendor terminal juggling, no copied API keys, no second UI to learn: open the panel, pick a model, talk to it.

## What you get

- **One composer, many vendors.** Switch between Claude, OpenAI Codex, Alibaba Qwen, xAI Grok, Cursor and Moonshot Kimi from the model picker, with a `Best / All` toggle and a per-session effort control.
- **Accounts that log themselves in.** _Manage accounts_ installs each vendor CLI and opens its sign-in page in your browser; Cukii Chat picks the session up on its own and shows a single connected / not-connected dot per vendor.
- **Sessions that survive.** Interrupted runs, remote SSH windows and restored history come back where you left them.
- **Long answers stay readable.** Sticky user messages fold to a single line while you scroll, and unfold on demand.
- **Bug reports in one click.** Send a sanitised report about a stuck or wrong session straight to the team's board, with screenshots and diagnostics attached.
- **Remote-SSH ready.** The extension runs on the remote host, so your agents work against the machine that has your code.

## Getting started

1. Install the extension and open **Cukii Chat** from the activity bar (or run _Cukii Chat: Open in New Window_).
2. Open **Manage accounts…** from the composer menu and press **Install** for the vendor you own, then **Log in** — the browser opens, you sign in, the row turns connected.
3. Pick a model in the composer and send your first message with `Enter`.

## Requirements

- VS Code 1.70 or newer
- Node.js 20 or newer on the machine that runs the agents
- At least one vendor CLI (Cukii Chat can install it for you from _Manage accounts_)

## Privacy

Cukii Chat sends no analytics or telemetry. It talks to the network only for these:

- **Your vendor CLIs.** Your prompts go from the official vendor CLIs (Claude Code, Codex, Qwen Code, Grok, Cursor, Kimi) to their vendors, under your own accounts and their terms. Cukii Chat runs the unmodified CLIs and does not proxy your traffic.
- **Usage limits.** Claude and Codex limits come from the CLIs themselves; your stored Claude or Codex login is not read unless you turn on `cukii.usage.directVendorApi`. Kimi and Grok limits come from those vendors' own usage endpoints, signed in with the login their CLI keeps.
- **Bug reports.** Only when you press **Report a bug**: the text you write, a screenshot of the chat and a sanitised diagnostics file go to the maintainers' issue board. Secrets are masked before sending.
- **Updates.** The vendor CLIs that Cukii Chat installed for you are updated from npm, and the model catalogue is refreshed from this repository.
- **Memory.** Only after you connect a Cukii Box memory endpoint with your own token.

## Feedback

Something stuck or answered wrongly? Use **Report a bug** in the session — it reaches the team with everything needed to reproduce. Issues and source live in the [repository](https://github.com/rozhkovsvyat/agent-hub-vscode).

## License

Apache-2.0 — see [LICENSE](./LICENSE.txt) and [NOTICE](./NOTICE).
