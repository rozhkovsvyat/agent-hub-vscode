# The activity-bar icon: why it is `cukii-activity.svg`

`contributes.viewsContainers.activitybar` and `contributes.views.cukii` both
point at `media/cukii-activity.svg`. That is the cookie, and it is what the
owner asked for after seeing the codicon stand-in — it also matches the
reference client: Claude Code ships `resources/claude-logo.svg` the same way,
with no `extensionKind` (so, like Cukii, it runs workspace-side).

## The trade this makes

VS Code paints an activity-bar icon as a **CSS mask**, not as an image
(`workbench.desktop.main.js`, the `.action-label.<hash>` rule):

```css
mask: url(<icon>) no-repeat 50% 50%;
-webkit-mask: url(<icon>) no-repeat 50% 50%;
```

Cukii declares `"extensionKind": ["workspace"]` — it spawns vendor CLIs and
reads the workspace, so it must run on the remote host. In a desktop Remote-SSH
window the extension therefore lives on the remote, and VS Code rewrites its
icon URI (`RemoteAuthorities.rewrite`) to

```
vscode-remote-resource://<host>:<port>/vscode-remote-resource?path=…&tkn=…
```

The desktop app proxies that scheme straight to `http://<host>:<port>/…`
(`main.js`, `registerHttpProtocol`) forwarding only url and method — the
`Origin` header is dropped. The server only answers with
`Access-Control-Allow-Origin` when the request's origin matches its web
endpoint (`server-main.js`), so it answers with none. The workbench is served
from `vscode-file://vscode-app`, so the icon is a cross-origin resource with no
CORS headers, and a CSS mask requires a CORS-same-origin resource — unlike
`background-image`, which has no such rule. The mask resolves to nothing and
the icon is an empty square. There is no fallback: when the icon is a URI the
label is painted purely through the mask
(`compositeBarActionItem.iconUrl ? backgroundColor : color`).

Two independent confirmations of the mechanism:

- VS Code refuses to persist a URI icon into the activity-bar cache in a remote
  window — `saveCachedViewContainers` writes
  `icon: isUri(r.icon) && remoteAuthority ? undefined : r.icon`.
- `extensionKind` was `["ui","workspace"]` up to 2.0.84, where `ui` came first
  and the extension ran **locally** — a `file://` icon rewritten to
  `vscode-file://vscode-app`, same origin as the workbench, so the mask worked.

Reproduction of the CSS rule — two local HTTP origins serving the identical
SVG, page loaded from the first:

| mask source                                    | result         |
| ---------------------------------------------- | -------------- |
| same origin                                    | cookie renders |
| other origin, no `Access-Control-Allow-Origin` | blank square   |

The same experiment with `@font-face` behaves identically, so a contributed
icon font (`contributes.icons` with a `fontPath`) is not a way out either.

## So what happens where

| window                        | icon         |
| ----------------------------- | ------------ |
| local (the everyday one here) | the cookie   |
| desktop Remote-SSH            | blank square |

A `ThemeIcon` (`$(…)`) is the only icon that survives every window type,
because it is drawn from the workbench's own bundled codicon font. It costs the
cookie: `$(circle-large-filled)` is a plain filled circle. That trade was tried
in 2.0.98 and rejected — the icon people actually look at is the local one.

To go back to it, set both `contributes.viewsContainers.activitybar[0].icon`
and `contributes.views.cukii[0].icon` to `"$(circle-large-filled)"`. There is
no third option while the extension must run workspace-side.
