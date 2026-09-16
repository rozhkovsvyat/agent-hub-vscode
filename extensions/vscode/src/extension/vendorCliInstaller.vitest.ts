import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import {
  vendorInstallTerminalSpec,
  vendorSpawnEnv,
} from "./vendorCliInstaller";

const NPM_ONLY_VENDORS = ["claude", "codex", "grok", "kimi", "qwen"] as const;
const NPM_ONLY_PROGRAMS: Record<(typeof NPM_ONLY_VENDORS)[number], string> = {
  claude: "claude",
  codex: "codex",
  grok: "grok",
  kimi: "kimi",
  qwen: "qwen",
};

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
    expect(spec!.command).toContain("@xai-official/grok@latest");
    expect(spec!.command).not.toContain("Set-ExecutionPolicy");
    expect(spec!.command).not.toMatch(/\bnpm install\b/);
  });

  it.runIf(process.platform === "win32")(
    "executes a real npm.cmd even when a hostile npm.ps1 is earlier on PATH",
    () => {
      const directory = fs.mkdtempSync("D:\\Scratch\\cukii-npm-command-probe-");
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

  it("installs Claude Code through Anthropic's npm package in a user-owned prefix", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const spec = vendorInstallTerminalSpec("claude", platform)!;
      expect(spec.shellPath).toBe("/bin/bash");
      expect(spec.command).toContain('npm install -g --prefix "$HOME/.local"');
      expect(spec.command).toContain("@anthropic-ai/claude-code@latest");
      expect(spec.command).toContain('"$HOME/.local/bin/claude" --version');
      expect(spec.command).not.toContain("https://claude.ai/install.sh");
    }
  });

  it("installs Node under $HOME for the npm-only vendors", () => {
    const spec = vendorInstallTerminalSpec("codex", "darwin")!;

    expect(spec.command).toContain("$HOME/.local/share/cukii/node");
    expect(spec.command).toContain("https://nodejs.org/dist/");
    expect(spec.command).toContain('npm install -g --prefix "$HOME/.local"');
    expect(spec.command).toContain("@openai/codex@latest");
    // Both CPU families of both platforms, or the tarball name is wrong for
    // exactly the machines we cannot test from here.
    for (const token of ["arm64", "x64", "Darwin", "Linux"]) {
      expect(spec.command).toContain(token);
    }
  });

  it("reuses only a suitable Cukii-owned Node and ignores the system npm", () => {
    const command = vendorInstallTerminalSpec("grok", "linux")!.command;
    const probeAt = command.indexOf("cukii_node_major=0");
    const downloadAt = command.indexOf("https://nodejs.org/dist/");
    expect(probeAt).toBeGreaterThanOrEqual(0);
    expect(command).toContain('[ "$cukii_node_major" -lt 22 ]');
    expect(command).toContain('PATH="$HOME/.local/share/cukii/node/bin:$PATH"');
    expect(command).not.toContain("if ! command -v npm");
    expect(downloadAt).toBeGreaterThan(probeAt);
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
    15_000,
  );

  // 🔴 2.0.132 published a `codex` the owner could not launch at all: the
  // installer decided success by running the CLI while its own PATH still
  // carried the private Node — the one environment in which an npm shim can
  // start. Nothing downstream could disagree, so "installation verified"
  // appeared next to a CLI that died in its own shebang (card 3d82899a).
  it.each(["darwin", "linux"] as const)(
    "decides a %s install from a clean environment, not the installer's own",
    (platform) => {
      for (const vendor of NPM_ONLY_VENDORS) {
        const program = NPM_ONLY_PROGRAMS[vendor];
        const command = vendorInstallTerminalSpec(vendor, platform)!.command;
        const verify = command
          .split("\n")
          .find((line) => line.includes(`/bin/${program}" --version`));

        expect({ vendor, verify }).toMatchObject({
          verify: expect.stringContaining("env PATH=/usr/bin:/bin"),
        });
        // The negative control on the check itself: the private runtime must
        // be unreachable from the environment that declares the CLI working.
        expect(verify).not.toContain("share/cukii/node");
        // A check that discards the reason is how this defect survived two
        // releases as a bare "exit code 1".
        expect(command).toContain('echo "$cukii_verify" >&2');
      }
    },
  );

  // The npm shim for these packages is a Node script — the registry lists
  // `bin/codex.js` for `@openai/codex` — so the installed entry point must
  // carry its own runtime instead of trusting the caller's PATH. Anthropic
  // ships a native executable, which is why the same installer looked healthy
  // for one vendor out of five.
  it.each(["darwin", "linux"] as const)(
    "owns the %s entry point with a wrapper that needs nothing on PATH",
    (platform) => {
      for (const vendor of NPM_ONLY_VENDORS) {
        const program = NPM_ONLY_PROGRAMS[vendor];
        const command = vendorInstallTerminalSpec(vendor, platform)!.command;
        const installed = `$HOME/.local/bin/${program}`;
        const moved = `$HOME/.local/libexec/cukii/${program}`;

        // 🔴 A global npm bin entry is a relative symlink into
        // `lib/node_modules`. Moving it re-bases `../lib/...` onto the new
        // parent and leaves a dangling link, which is what failed the macOS
        // gate for claude and codex alike. It must be resolved in place, and
        // only a real file may be moved aside.
        expect(command).toContain(`if [ -L "${installed}" ]; then`);
        expect(command).toContain("realpathSync");
        expect(command).toContain(`mv "${installed}" "${moved}"`);
        expect(command).toContain(`cukii_real="${moved}"`);
        // The entry must be unlinked before the wrapper is written, or `cat >`
        // follows the symlink and overwrites the package's own file.
        expect(command.indexOf(`rm -f "${installed}"`)).toBeGreaterThan(
          command.indexOf(`if [ -L "${installed}" ]; then`),
        );
        expect(command.indexOf(`rm -f "${installed}"`)).toBeLessThan(
          command.indexOf(`cat > "${installed}" <<CUKII_VENDOR_WRAPPER`),
        );
        expect(command).toContain(
          `cat > "${installed}" <<CUKII_VENDOR_WRAPPER`,
        );
        expect(command).toContain(
          'PATH="$HOME/.local/share/cukii/node/bin:\\$PATH"',
        );
        expect(command).toContain('exec "$cukii_real" "\\$@"');
        expect(command).toContain(`chmod +x "${installed}"`);
        // A `/bin/sh` script, not an inline `VAR=value command` prefix: the
        // latter is not valid syntax in fish, which is a legitimate default
        // shell for an owner we cannot reach from here.
        expect(command).toContain("#!/bin/sh");
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

// Defense in depth beside the installed wrapper: a vendor that updates itself
// through npm rewrites the shim and drops the wrapper, and Cukii's own probes
// and chat bridge have to keep launching the CLI through that.
describe("vendorSpawnEnv", () => {
  it("puts the private runtime and the installed CLI directory first", () => {
    expect(
      vendorSpawnEnv({ PATH: "/usr/bin:/bin" }, "/Users/owner", "darwin").PATH,
    ).toBe(
      "/Users/owner/.local/share/cukii/node/bin:/Users/owner/.local/bin:/usr/bin:/bin",
    );
  });

  it("does not duplicate a directory the host already exported", () => {
    expect(
      vendorSpawnEnv(
        { PATH: "/Users/owner/.local/bin:/usr/bin" },
        "/Users/owner",
        "darwin",
      ).PATH,
    ).toBe(
      "/Users/owner/.local/share/cukii/node/bin:/Users/owner/.local/bin:/usr/bin",
    );
  });

  it("honours a lowercase path key instead of adding a second one", () => {
    const env = vendorSpawnEnv({ path: "/usr/bin" }, "/Users/owner", "darwin");
    expect(Object.keys(env)).toEqual(["path"]);
    expect(env.path).toBe(
      "/Users/owner/.local/share/cukii/node/bin:/Users/owner/.local/bin:/usr/bin",
    );
  });

  // Windows installs Node machine-wide through winget, so there is no private
  // runtime to inject and no `:`-delimited PATH to rewrite.
  it("leaves Windows untouched", () => {
    expect(
      vendorSpawnEnv({ Path: "C:\\Windows" }, "C:\\Users\\owner", "win32"),
    ).toEqual({ Path: "C:\\Windows" });
  });
});
