import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { vendorInstallTerminalSpec } from "./vendorCliInstaller";

describe("vendorInstallTerminalSpec", () => {
  it("uses npm.cmd and winget Node.js LTS without weakening Windows policy", () => {
    const spec = vendorInstallTerminalSpec("grok", "win32", {
      SystemRoot: "C:\\Windows",
    });

    expect(spec).toMatchObject({
      shellPath:
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      shellArgs: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"],
      closesTerminal: true,
    });
    expect(spec!.command).toContain("Get-Command npm.cmd");
    expect(spec!.command).toContain("OpenJS.NodeJS.LTS");
    expect(spec!.command).toContain("administrator approval is required");
    expect(spec!.command).toContain("Start-Process");
    expect(spec!.command).toContain("-Verb RunAs");
    expect(spec!.command).not.toContain("Restart VS Code as Administrator");
    expect(spec!.command).toContain(
      "@xai-official/grok@latest",
    );
    expect(spec!.command).not.toContain("Set-ExecutionPolicy");
    expect(spec!.command).not.toMatch(/\bnpm install\b/);
  });

  it.runIf(process.platform === "win32")(
    "executes a real npm.cmd even when a hostile npm.ps1 is earlier on PATH",
    () => {
      const directory = fs.mkdtempSync(
        "D:\\Scratch\\cukii-npm-command-probe-",
      );
      const receipt = path.join(directory, "receipt.txt");
      fs.writeFileSync(
        path.join(directory, "npm.cmd"),
        '@echo off\r\necho %* > "%CUKII_TEST_RECEIPT%"\r\nexit /b 0\r\n',
      );
      fs.writeFileSync(
        path.join(directory, "npm.ps1"),
        "throw 'npm.ps1 must never execute'\r\n",
      );
      const spec = vendorInstallTerminalSpec("grok", "win32")!;
      const isolatedEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "path",
        ),
      );
      try {
        execFileSync(
          spec.shellPath,
          [...spec.shellArgs, "-Command", spec.command],
          {
            env: {
              ...isolatedEnv,
              CUKII_TEST_RECEIPT: receipt,
              Path: directory,
            },
            stdio: "pipe",
          },
        );
        expect(fs.readFileSync(receipt, "utf8").trim()).toBe(
          "install -g @xai-official/grok@latest",
        );
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("bootstraps Homebrew and Node on an unprepared Mac", () => {
    const spec = vendorInstallTerminalSpec("claude", "darwin")!;

    expect(spec.shellPath).toBe("/bin/bash");
    expect(spec.command).toContain("Homebrew/install/HEAD/install.sh");
    expect(spec.command).toContain("brew install node");
    expect(spec.command).toContain("npm config set prefix \"$HOME/.local\"");
    expect(spec.command).toContain("@anthropic-ai/claude-code@latest");
    expect(spec.command).not.toContain("winget");
  });

  it("uses supported system package managers and a user npm prefix on Linux", () => {
    const spec = vendorInstallTerminalSpec("codex", "linux")!;

    for (const manager of ["apt-get", "dnf", "yum", "zypper", "pacman"]) {
      expect(spec.command).toContain(manager);
    }
    expect(spec.command).toContain("root or sudo");
    expect(spec.command).toContain("npm config set prefix \"$HOME/.local\"");
    expect(spec.command).toContain("@openai/codex@latest");
    expect(spec.command).not.toContain("sudo npm install");
  });

  it.each(["darwin", "linux"] as const)(
    "emits a syntactically valid %s bash program",
    (platform) => {
      const spec = vendorInstallTerminalSpec("codex", platform)!;
      const parsed = spawnSync("bash", ["-n"], {
        input: spec.command,
        encoding: "utf8",
      });
      expect(parsed.error).toBeUndefined();
      expect(parsed.stderr).toBe("");
      expect(parsed.status).toBe(0);
      expect(spec.command).not.toContain("then;");
      expect(spec.command).not.toContain("else;");
    },
  );

  it("uses Cursor's official platform-specific installers", () => {
    expect(vendorInstallTerminalSpec("cursor", "win32")!.command).toContain(
      "https://cursor.com/install?win32=true",
    );
    for (const platform of ["darwin", "linux"] as const) {
      const spec = vendorInstallTerminalSpec("cursor", platform)!;
      expect(spec.command).toBe(
        "set -e; curl https://cursor.com/install -fsS | bash; exit 0",
      );
    }
  });

  it("does not invent an installer for a postponed vendor", () => {
    expect(vendorInstallTerminalSpec("deepseek", "linux")).toBeUndefined();
  });
});
