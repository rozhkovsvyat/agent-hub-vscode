#!/usr/bin/env bash
# Stage native/runtime artefacts into a fresh worktree of agent-hub-vscode.
# The vendor bridge is an installed git dependency (dist committed upstream),
# so it needs nothing here; the ritual covers the monorepo internals only.
# Usage: scripts/prepare-worktree-runtime.sh <worktree-root> [main-checkout]
set -euo pipefail

W="${1:?worktree root required}"
M="${2:-$(dirname "$(cd "$(dirname "$W")" && pwd)")}"

npm_install() {
  (cd "$1" && npm install --ignore-scripts)
}

npm_install "$W/core"
npm_install "$W/extensions/vscode"

for p in config-types config-yaml fetch llm-info openai-adapters terminal-security; do
  (cd "$W/packages/$p" && npm install --ignore-scripts && npm run build)
done

mkdir -p "$W/core/node_modules/sqlite3/build/Release" \
         "$W/extensions/vscode/node_modules/sqlite3/build/Release"
cp "$M/core/node_modules/sqlite3/build/Release/node_sqlite3.node" \
   "$W/core/node_modules/sqlite3/build/Release/"
cp "$M/core/node_modules/sqlite3/build/Release/node_sqlite3.node" \
   "$W/extensions/vscode/node_modules/sqlite3/build/Release/"
cp -r "$M/extensions/vscode/node_modules/sharp/build" \
      "$W/extensions/vscode/node_modules/sharp/"
if [ -d "$M/extensions/vscode/node_modules/sharp/vendor" ]; then
  cp -r "$M/extensions/vscode/node_modules/sharp/vendor" \
        "$W/extensions/vscode/node_modules/sharp/"
fi
cp "$M/extensions/vscode/node_modules/ffmpeg-static/ffmpeg.exe" \
   "$W/extensions/vscode/node_modules/ffmpeg-static/"

mkdir -p "$W/extensions/vscode/build"

echo "Worktree runtime staged: $W"
