# Why the activity-bar icon is a codicon and not `cukii-activity.svg`

`cukii-activity.svg` is correct and is still the mark used inside the webview.
It is **not** used for `contributes.viewsContainers.activitybar` or
`contributes.views[].icon`, and putting it back there brings back the blank
square several people have chased.

## What actually happens

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
endpoint (`server-main.js`), so it answers with none.

The workbench itself is served from `vscode-file://vscode-app`. So the icon is
a **cross-origin resource with no CORS headers**, and a CSS mask requires a
CORS-same-origin resource — unlike `background-image`, which has no such rule.
The mask silently resolves to nothing and the icon is an empty square. There is
no fallback: when the icon is a URI the label is painted purely through the
mask (`compositeBarActionItem.iconUrl ? backgroundColor : color`).

Two independent confirmations that this is the mechanism:

- VS Code itself refuses to persist a URI icon into the activity-bar cache in a
  remote window — `saveCachedViewContainers` writes
  `icon: isUri(r.icon) && remoteAuthority ? undefined : r.icon` — so there is
  not even a cached icon to paint before the extension host registers.
- The regression matches the manifest history: `extensionKind` was
  `["ui","workspace"]` up to 2.0.84, where `ui` came first and the extension ran
  **locally** — a `file://` icon rewritten to `vscode-file://vscode-app`, same
  origin as the workbench, so the mask worked. From 2.0.86 the kind is
  `["workspace"]` and the icon has been blank in remote windows since.

## Reproduction of the CSS rule

Two local HTTP origins serving the identical SVG; the page is loaded from the
first one:

| mask source                                    | result         |
| ---------------------------------------------- | -------------- |
| same origin                                    | cookie renders |
| other origin, no `Access-Control-Allow-Origin` | blank square   |

The same experiment with `@font-face` behaves identically, which is why a
contributed icon font (`contributes.icons` with a `fontPath`) is **not** a way
out either: fonts are CORS-restricted too, and the font would be loaded from
the same cross-origin remote host.

## What is left

A `ThemeIcon` (`$(…)`) is rendered from the workbench's own bundled codicon
font, which is always same-origin, so it is the only icon that survives every
window type. `$(circle-large-filled)` is the cookie's silhouette.

To go back to the cookie, change both `contributes.viewsContainers.activitybar`
and `contributes.views.cukii` back to `media/cukii-activity.svg` — it will look
right in a local window and be an empty square in Remote-SSH. That is the whole
trade; there is no third option while the extension must run workspace-side.
