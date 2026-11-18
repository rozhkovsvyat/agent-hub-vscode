import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const extensionRoot = path.resolve(__dirname, "..");
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-vsix-"));

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("VSIX package list", () => {
  // This case shells out to `vsce ls`, which cold-starts a second Node process
  // and walks the fixture tree. Alone it lands in ~2s, but inside the full
  // parallel suite it has been measured at 27s — well past the 5s default, so
  // the whole suite went red for a reason that had nothing to do with the
  // ignore rules under test.
  it("keeps deep native/runtime payloads while excluding source maps", () => {
    fs.copyFileSync(
      path.join(extensionRoot, ".vscodeignore"),
      path.join(fixtureRoot, ".vscodeignore"),
    );
    fs.writeFileSync(
      path.join(fixtureRoot, "package.json"),
      JSON.stringify({
        name: "cukii-vsix-ignore-fixture",
        version: "0.0.0",
        publisher: "cukii",
        engines: { vscode: "^1.70.0" },
      }),
    );

    for (const file of [
      "out/node_modules/@lancedb/vectordb-win32-x64-msvc/index.node",
      "out/node_modules/@lancedb/vectordb-win32-x64-msvc/index.js.map",
      "out/node_modules/@vscode/ripgrep/bin/rg.exe",
      "out/node_modules/@vscode/ripgrep/lib/index.js.map",
      "out/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node",
      "out/node_modules/onnxruntime-node/dist/index.js.map",
      "out/runtime/ffmpeg.exe",
      "out/runtime/ffmpeg.map",
      "out/cukiiMemoryProxy.js",
      // The discipline fallback. If `.vscodeignore` ever swallows it, a machine
      // that cannot reach the box silently loses the contract again.
      "media/cukii-memory-rules.md",
    ]) {
      const destination = path.join(fixtureRoot, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, "fixture");
    }

    const vsce = path.join(
      extensionRoot,
      "node_modules",
      "@vscode",
      "vsce",
      "vsce",
    );
    const packageList = execFileSync(
      process.execPath,
      [vsce, "ls", "--no-dependencies"],
      { cwd: fixtureRoot, encoding: "utf8" },
    ).split(/\r?\n/);

    expect(packageList).toEqual(
      expect.arrayContaining([
        "out/node_modules/@lancedb/vectordb-win32-x64-msvc/index.node",
        "out/node_modules/@vscode/ripgrep/bin/rg.exe",
        "out/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node",
        "out/runtime/ffmpeg.exe",
        "out/cukiiMemoryProxy.js",
        "media/cukii-memory-rules.md",
      ]),
    );
    expect(packageList.filter((file) => file.endsWith(".map"))).toEqual([]);
  }, 60_000);
});
