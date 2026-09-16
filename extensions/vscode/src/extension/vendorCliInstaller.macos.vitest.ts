import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expect, it } from "vitest";
import { runVendorInstallProcess } from "./vendorCliInstallProcess";
import { vendorInstallTerminalSpec } from "./vendorCliInstaller";

it.runIf(
  process.platform === "darwin" &&
    process.env.CUKII_REAL_VENDOR_INSTALL_SMOKE === "1",
)(
  "installs and launches Anthropic CLI through the exact macOS Cukii path",
  async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "cukii-claude-install-"),
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

      const spec = vendorInstallTerminalSpec("claude", "darwin")!;
      const result = await runVendorInstallProcess(spec, {
        env: cleanEnvironment,
        platform: "darwin",
        onOutput: (chunk) => chunks.push(chunk),
      });

      expect({ result, output: chunks.join("") }).toMatchObject({
        result: { exitCode: 0, signal: null },
      });
      const executable = path.join(home, ".local", "bin", "claude");
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
      const installedVersion = spawnSync(executable, ["--version"], {
        env: cleanEnvironment,
        encoding: "utf8",
      });
      expect({
        status: installedVersion.status,
        stderr: installedVersion.stderr,
      }).toMatchObject({ status: 0, stderr: "" });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
  180_000,
);
