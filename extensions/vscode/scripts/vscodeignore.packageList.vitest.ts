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
  it("excludes source maps after restoring the runtime payload", () => {
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
      "out/node_modules/runtime.node",
      "out/node_modules/runtime.map",
      "out/runtime/ffmpeg.exe",
      "out/runtime/ffmpeg.map",
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

    expect(packageList).toContain("out/node_modules/runtime.node");
    expect(packageList).toContain("out/runtime/ffmpeg.exe");
    expect(packageList.filter((file) => file.endsWith(".map"))).toEqual([]);
  });
});
