<div align="center">

![Cukii Chat](https://raw.githubusercontent.com/rozhkovsvyat/agent-hub-vscode/cukii/trunk/extensions/vscode/media/icon.png)

<h1 align="center">Cukii Chat</h1>

**One chat for every AI coding CLI you already pay for**

[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cukii.cukii-vscode)

</div>

Cukii Chat is a VS Code extension that puts the official command-line agents — Claude Code, Codex, Qwen Code, Grok, Cursor and Kimi — behind one chat panel. It runs the unmodified vendor CLIs under your own accounts; it does not proxy your traffic or resell access.

The user guide is the [extension README](./extensions/vscode/README.md). This file is for people working on the code.

## Repository layout

| Path                                                             | What lives there                                                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `extensions/vscode/`                                             | The VS Code extension host side: activation, vendor runs, accounts, usage, bug reports              |
| `gui/`                                                           | The chat webview (React + Vite)                                                                     |
| `core/`                                                          | Shared runtime, inherited from Continue and being trimmed down                                      |
| `packages/`                                                      | Small shared packages (config types, fetch, …)                                                      |
| [`vendor-bridge`](https://github.com/rozhkovsvyat/vendor-bridge) | Separate repository, pinned by tag: spawns the vendor CLIs and turns their streams into chat events |

## Build and test

Requires Node.js 20+.

```sh
npm install                      # root
(cd core && npm install)
(cd gui && npm install && npm run build)
(cd extensions/vscode && npm install)

(cd gui && npx vitest run)                       # GUI tests
(cd extensions/vscode && npx vitest run)         # extension tests
(cd extensions/vscode && npm run tsc:check)      # types
(cd extensions/vscode && node scripts/package-cross-target.js --target darwin-arm64)  # a VSIX
```

Run the extension from source with the `Launch extension` debug configuration in VS Code.

## Feedback

Use **Report a bug** inside the chat — it attaches sanitised diagnostics. Security issues: see [SECURITY.md](./SECURITY.md).

## License and origin

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./extensions/vscode/NOTICE). Cukii Chat started as a fork of [Continue](https://github.com/continuedev/continue) and is not affiliated with it, nor with any of the vendors whose CLIs it runs.
