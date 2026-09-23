import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expect, it } from "vitest";
import { runVendorInstallProcess } from "./vendorCliInstallProcess";
import { vendorInstallTerminalSpec } from "./vendorCliInstaller";

/**
 * 🔴 `codex` is here because covering only `claude` is what let 2.0.132 ship a
 * CLI the owner could not launch. Anthropic's package installs a native
 * executable, so it never needed `node` after the install and this gate stayed
 * green; `@openai/codex` installs a Node script (`bin/codex.js`) and died with
 * `env: node: No such file or directory` in the owner's own terminal (board
 * card 3d82899a, 2026-09-16). One vendor of each shape is the minimum.
 */
const REAL_INSTALL_VENDORS = [
  { vendor: "claude", program: "claude" },
  { vendor: "codex", program: "codex" },
] as const;

it
  .runIf(
    process.platform === "darwin" &&
      process.env.CUKII_REAL_VENDOR_INSTALL_SMOKE === "1",
  )
  .each(REAL_INSTALL_VENDORS)(
  "installs and launches $vendor through the exact macOS Cukii path",
  async ({ vendor, program }) => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), `cukii-${vendor}-install-`),
    );
    const chunks: string[] = [];
    const cleanMacPath = "/usr/bin:/bin:/usr/sbin:/sbin";
    const cleanEnvironment = {
      ...process.env,
      HOME: home,
      PATH: cleanMacPath,
      SUDO_USER: "",
    };
    try {
      // The GitHub runner itself is provisioned with actions/setup-node so it
      // can execute Vitest. Strip that toolcache from the child: this must
      // exercise the same no-node/no-npm path as a fresh VS Code from Dock.
      const preflight = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-c", "command -v node; command -v npm"],
        { env: cleanEnvironment, encoding: "utf8" },
      );
      expect(preflight.status).not.toBe(0);
      expect(preflight.stdout.trim()).toBe("");

      const spec = vendorInstallTerminalSpec(vendor, "darwin")!;
      const result = await runVendorInstallProcess(spec, {
        env: cleanEnvironment,
        platform: "darwin",
        onOutput: (chunk) => chunks.push(chunk),
      });

      // 🔴 The assertion diff shows the exit code and nothing else, and this
      // gate has already failed twice on a runner nobody can log into. The
      // installer's own words have to reach the CI log.
      if (result.exitCode !== 0) {
        console.error(
          `[cukii ${vendor} install failed with ${result.exitCode}]\n${chunks.join("")}`,
        );
      }
      expect({ result, output: chunks.join("") }).toMatchObject({
        result: { exitCode: 0, signal: null },
      });
      const executable = path.join(home, ".local", "bin", program);
      expect(fs.existsSync(executable)).toBe(true);
      expect(fs.statSync(executable).mode & 0o111).not.toBe(0);
      const privateNode = path.join(
        home,
        ".local",
        "share",
        "cukii",
        "node",
        "bin",
        "node",
      );
      expect(fs.existsSync(privateNode)).toBe(true);

      // The decisive assertion, and the one the previous gate could not make
      // for an npm-shim vendor: the installed entry point starts with nothing
      // of ours on PATH, exactly as the owner's login shell will start it.
      const installedVersion = spawnSync(executable, ["--version"], {
        env: cleanEnvironment,
        encoding: "utf8",
      });
      expect({
        vendor,
        status: installedVersion.status,
        shebangFailure: /env: node|not found/.test(installedVersion.stderr),
      }).toMatchObject({ status: 0, shebangFailure: false });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
  420_000,
);
