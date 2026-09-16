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
    try {
      const spec = vendorInstallTerminalSpec("claude", "darwin")!;
      const result = await runVendorInstallProcess(spec, {
        env: { ...process.env, HOME: home, SUDO_USER: "" },
        platform: "darwin",
        onOutput: (chunk) => chunks.push(chunk),
      });

      expect({ result, output: chunks.join("") }).toMatchObject({
        result: { exitCode: 0, signal: null },
      });
      const executable = path.join(home, ".local", "bin", "claude");
      expect(fs.existsSync(executable)).toBe(true);
      expect(fs.statSync(executable).mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
  180_000,
);
