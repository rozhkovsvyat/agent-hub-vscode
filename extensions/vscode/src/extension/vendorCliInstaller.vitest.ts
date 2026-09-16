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

  // The defect this replaces: on an unprepared Mac the installer installed
  // Homebrew, whose own installer requires administrator rights. The owner got
  // two password prompts and `/bin/bash --noprofile --norc` exited 1
  // (screenshot, 2026-09-16). Nothing Cukii installs may need elevation.
  it.each(["darwin", "linux"] as const)(
    "never asks %s for elevation, a system package manager, or PowerShell",
    (platform) => {
      for (const vendor of [
        "claude",
        "codex",
        "grok",
        "kimi",
        "qwen",
        "cursor",
      ] as const) {
        const command = vendorInstallTerminalSpec(vendor, platform)!.command;
        for (const forbidden of [
          "sudo",
          "brew",
          "apt-get",
          "dnf",
          "yum",
          "zypper",
          "pacman",
          "irm",
          "iex",
          "powershell",
          "winget",
        ]) {
          // Match the program being *invoked*, not merely named: the preflight
          // warning has to be able to say the word "sudo" to explain itself.
          const invoked = new RegExp(String.raw`(^|[\n;&|(]\s*)${forbidden}\s`);
          expect({
            vendor,
            platform,
            forbidden,
            invoked: invoked.test(command),
          }).toMatchObject({ invoked: false });
        }
        expect(command).not.toContain("Homebrew");
        expect(command).toContain("No administrator rights are required");
      }
    },
  );

  // Told before anything is downloaded, per the owner's request to be warned
  // up front. The warning is that elevation is wrong here, not required.
  it.each(["darwin", "linux"] as const)(
    "refuses an elevated %s run before touching the machine",
    (platform) => {
      for (const vendor of ["claude", "codex", "cursor"] as const) {
        const command = vendorInstallTerminalSpec(vendor, platform)!.command;
        const refusalAt = command.indexOf('if [ "$(id -u)" -eq 0 ]');
        expect(refusalAt).toBeGreaterThanOrEqual(0);
        expect(command).toContain("do not run this installer with sudo");
        expect(command).toContain("exit 27");
        // Nothing may be downloaded or written before the refusal decides.
        for (const effect of ["curl ", "mkdir ", "rm -rf", "npm install"]) {
          const effectAt = command.indexOf(effect);
          if (effectAt >= 0) expect(effectAt).toBeGreaterThan(refusalAt);
        }
      }
    },
  );

  it("installs Claude Code with its own installer instead of npm", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const spec = vendorInstallTerminalSpec("claude", platform)!;
      expect(spec.shellPath).toBe("/bin/bash");
      expect(spec.command).toContain("https://claude.ai/install.sh");
      // Anthropic's installer needs no Node at all, so requiring npm here
      // would reintroduce the whole package-manager bootstrap for nothing.
      expect(spec.command).not.toContain("npm");
      expect(spec.command).not.toContain("@anthropic-ai/claude-code");
    }
  });

  it("installs Node under $HOME for the npm-only vendors", () => {
    const spec = vendorInstallTerminalSpec("codex", "darwin")!;

    expect(spec.command).toContain("$HOME/.local/share/cukii/node");
    expect(spec.command).toContain("https://nodejs.org/dist/");
    expect(spec.command).toContain('npm config set prefix "$HOME/.local"');
    expect(spec.command).toContain("@openai/codex@latest");
    // Both CPU families of both platforms, or the tarball name is wrong for
    // exactly the machines we cannot test from here.
    for (const token of ["arm64", "x64", "Darwin", "Linux"]) {
      expect(spec.command).toContain(token);
    }
  });

  it("reuses a Node it already installed instead of downloading it again", () => {
    const command = vendorInstallTerminalSpec("grok", "linux")!.command;
    const reuseAt = command.indexOf(
      'if [ -x "$HOME/.local/share/cukii/node/bin/npm" ]',
    );
    const downloadAt = command.indexOf("https://nodejs.org/dist/");
    expect(reuseAt).toBeGreaterThanOrEqual(0);
    expect(downloadAt).toBeGreaterThan(reuseAt);
  });

  it.each(["darwin", "linux"] as const)(
    "emits a syntactically valid %s bash program for every vendor",
    (platform) => {
      for (const vendor of [
        "claude",
        "codex",
        "grok",
        "kimi",
        "qwen",
        "cursor",
      ] as const) {
        const spec = vendorInstallTerminalSpec(vendor, platform)!;
        const parsed = spawnSync("bash", ["-n"], {
          input: spec.command,
          encoding: "utf8",
        });
        expect(parsed.error).toBeUndefined();
        expect(`${vendor}: ${parsed.stderr}`).toBe(`${vendor}: `);
        expect(parsed.status).toBe(0);
        expect(spec.command).not.toContain("then;");
        expect(spec.command).not.toContain("else;");
      }
    },
  );

  it("uses Cursor's official platform-specific installers", () => {
    expect(vendorInstallTerminalSpec("cursor", "win32")!.command).toContain(
      "https://cursor.com/install?win32=true",
    );
    for (const platform of ["darwin", "linux"] as const) {
      const spec = vendorInstallTerminalSpec("cursor", platform)!;
      expect(spec.command).toContain("curl https://cursor.com/install -fsS");
      expect(spec.command).not.toContain("win32=true");
    }
  });

  it("does not invent an installer for a postponed vendor", () => {
    expect(vendorInstallTerminalSpec("deepseek", "linux")).toBeUndefined();
  });
});
