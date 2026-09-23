# @cukii/vendor-bridge

Node-only, vscode-free vendor CLI bridge internals for the Cukii VS Code
extension: vendor CLI discovery and installers, the broker bridge route/spawn/
stream/cancel mechanics, bridge inbox/transcript/images, vendor auth probes,
permission capabilities and the Claude permission broker.

The extension consumes this package as TypeScript source
(`"main": "src/index.ts"`, `file:` dependency), exactly like it consumes
`core`. Since phase 3 the plugin imports `@cukii/vendor-bridge` directly —
the re-export shims under `extensions/vscode/src/extension/` are gone.
Plugin-side pieces that stay in the extension by design:

- `vendorBridgeHost.ts` — binds both host ports (below) and owns the eager
  `CUKII_*_SCRATCH_ROOT` constants (resolved from the lazy package path
  functions after the host config lands).
- `cukiiAccounts.ts` — `listCukiiAccounts`, composing vendor rows with
  Yougile (the yougile family stays in the plugin).
- `claudePermissionMcpWorker.ts` — two-line esbuild entry keeping the
  `out/claudePermissionMcpWorker.js` bundle name.
- `bridgeTerminalCommand.ts`, `voiceDictation.ts`, `cukiiMemoryVendorMcp.ts`,
  `cukiiMemoryProxy.ts` — VS Code-facing glue, deliberately not moved.

## Host configuration

The library ships machine-free defaults. The host (the Cukii plugin) pins its
own values from `extensions/vscode/src/extension/vendorBridgeHost.ts`:

- `configureVendorBridgeHost({ workspaceCwd, extensionInfo })` — workspace
  root for bridge runs and the extension identity used by the runtime canary.
  Default: no workspace (falls back to `process.cwd()`), no canary.
- `configureBridgeStorageHost({ preferredWindowsScratchRoot,
  preferredWindowsPnpmStoreRoot, forbiddenWindowsRoots })` — machine storage
  volumes. Default: no preferred roots and no forbidden list, so the Windows
  scratch ladder is `CUKII_SCRATCH_DIR` → `os.tmpdir()` and is safe on any
  machine. Options passed directly to `resolveBridgeStorageLayout` /
  `resolveWindowsScratchRoot` override the host config.

Modules that depend on the host values either take them as call options or are
reached only after the plugin's side-effect imports (`VsCodeExtension.ts` and
`VsCodeMessenger.ts` both `import "./vendorBridgeHost"` at module scope, so
activation always configures the ports before any bridge call).

## Live tests

`bridgeVendorAuth.live.vitest.ts` exercises real vendor CLIs and is gated:
it skips unless `CUKII_LIVE_AUTH_PROBE=1` is set, so the default suite needs
no installed vendors.

## Worktree runtime ritual

A fresh worktree has no `node_modules`, and the machine's npm policy blocks
postinstall scripts, so some native/runtime pieces must be staged by hand
(read-only from the main checkout, never modify it). The steps below are also
codified in `scripts/prepare-worktree-runtime.sh`:

```bash
W=<worktree>; M=<main checkout>
# 1. Dependencies (postinstalls intentionally skipped: puppeteer download and
#    sqlite3 node-gyp fail on this machine and are not needed for tests).
(cd "$W/packages/vendor-bridge" && npm install --ignore-scripts)
(cd "$W/core" && npm install --ignore-scripts)
(cd "$W/extensions/vscode" && npm install --ignore-scripts)
# 2. Internal packages must be built: their package.json points at dist/.
for p in config-types config-yaml fetch llm-info openai-adapters terminal-security; do
  (cd "$W/packages/$p" && npm install --ignore-scripts && npm run build)
done
# 3. Native binding and media binaries: copy the prebuilt artefacts.
mkdir -p "$W/core/node_modules/sqlite3/build/Release" \
         "$W/extensions/vscode/node_modules/sqlite3/build/Release"
cp "$M/core/node_modules/sqlite3/build/Release/node_sqlite3.node" \
   "$W/core/node_modules/sqlite3/build/Release/"
cp "$M/core/node_modules/sqlite3/build/Release/node_sqlite3.node" \
   "$W/extensions/vscode/node_modules/sqlite3/build/Release/"
cp -r "$M/extensions/vscode/node_modules/sharp/build" \
      "$W/extensions/vscode/node_modules/sharp/"
cp -r "$M/extensions/vscode/node_modules/sharp/vendor" \
      "$W/extensions/vscode/node_modules/sharp/" 2>/dev/null || true
cp "$M/extensions/vscode/node_modules/ffmpeg-static/ffmpeg.exe" \
   "$W/extensions/vscode/node_modules/ffmpeg-static/"
# 4. esbuild writes build/meta.json; the directory is gitignored.
mkdir -p "$W/extensions/vscode/build"
```

After that: `vitest run` in `packages/vendor-bridge`, `vitest run`,
`npm run tsc:check` and `npm run esbuild` in `extensions/vscode` all work in
the worktree.
