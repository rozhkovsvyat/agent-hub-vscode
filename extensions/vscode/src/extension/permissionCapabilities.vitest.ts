import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseVendorPermissionCapabilities } from "core/cukiiPermissionModes";

import { probeCliRoute, probeCommandForRoute } from "./permissionCapabilities";
import {
  commandCandidates,
  resolveProbeCommand,
} from "./permissionCapabilities";

describe("native permission capability probing", () => {
  // win32 only: `probeCommandForRoute` short-circuits to the bare route unless
  // `process.platform === "win32"`, so the ComSpec/`.cmd` wrapping it exists to
  // verify (Windows cannot CreateProcess a .cmd directly) is unreachable here.
  it.runIf(process.platform === "win32")(
    "runs a Windows .cmd probe through ComSpec without shell mode",
    () => {
      const probe = probeCommandForRoute(
        "C:\\Users\\owner\\scoop\\apps\\nodejs\\current\\bin\\claude.cmd",
      );
      expect(probe.program.toLowerCase()).toContain("cmd.exe");
      expect(probe.argsPrefix).toEqual([
        "/d",
        "/v:off",
        "/s",
        "/c",
        'call "C:\\Users\\owner\\scoop\\apps\\nodejs\\current\\bin\\claude.cmd"',
      ]);
    },
  );

  // win32 only: "not through WSL" is a Windows routing decision. Off Windows
  // `probeCommandForRoute` returns the route untouched, so both assertions
  // would pass without exercising the behaviour they describe.
  it.runIf(process.platform === "win32")(
    "does not route the native Cursor probe through WSL",
    () => {
      const probe = probeCommandForRoute(
        "C:\\Users\\owner\\.cursor\\bin\\agent.exe",
      );
      expect(probe.program).toContain("agent.exe");
      expect(probe.argsPrefix).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "executes a Codex .cmd route with spaces, Unicode, and metacharacters",
    async () => {
      const scratchRoot = "D:\\Scratch";
      const fixtureDir = await fs.mkdtemp(
        path.join(scratchRoot, "cukii cmd probe Ё & "),
      );
      const fixture = path.join(fixtureDir, "codex.cmd");
      try {
        await fs.writeFile(
          fixture,
          [
            "@echo off",
            'if /I "%~1"=="--help" (',
            "  echo --dangerously-bypass-approvals-and-sandbox Skip all prompts",
            "  exit /b 0",
            ")",
            'if /I "%~1"=="--version" (',
            "  echo codex 9.9.9",
            "  exit /b 0",
            ")",
            "echo unexpected argument: %~1 1>&2",
            "exit /b 1",
          ].join("\r\n"),
        );

        const probe = await probeCliRoute("codex", fixture);
        expect(probe.help).toContain(
          "--dangerously-bypass-approvals-and-sandbox",
        );
        expect(probe.version).toBe("codex 9.9.9");
        expect(
          parseVendorPermissionCapabilities("codex", probe.help, probe.version)
            .supportedModes,
        ).toEqual(["bypass"]);

        const missing = await probeCliRoute(
          "codex",
          path.join(fixtureDir, "missing.cmd"),
        );
        expect(missing).toEqual({ help: "" });

        const environmentVariable = "CUKII_REVIEW_ESCAPE";
        const marker = path.join(fixtureDir, "INJECTED.txt");
        const childMarker = path.join(fixtureDir, "CHILD_EXECUTED.txt");
        const childRoute = path.join(fixtureDir, "hostile child.cmd");
        const hostileRoute = path.join(
          fixtureDir,
          `literal%${environmentVariable}%percent`,
          "codex.cmd",
        );
        await fs.mkdir(path.dirname(hostileRoute));
        await fs.writeFile(hostileRoute, "@echo off\r\nexit /b 0\r\n");
        await fs.writeFile(
          childRoute,
          `@echo off\r\necho child > "${childMarker}"\r\nexit /b 0\r\n`,
        );
        const previousValue = process.env[environmentVariable];
        try {
          process.env[environmentVariable] =
            `" & echo injected > "${marker}" & call "${childRoute}" & rem "`;
          const hostile = await probeCliRoute("codex", hostileRoute);
          expect(hostile).toEqual({ help: "" });
          await expect(fs.access(marker)).rejects.toThrow();
          await expect(fs.access(childMarker)).rejects.toThrow();
        } finally {
          if (previousValue === undefined) {
            delete process.env[environmentVariable];
          } else {
            process.env[environmentVariable] = previousValue;
          }
        }

        const previousComSpec = process.env.ComSpec;
        try {
          process.env.ComSpec = path.join(fixtureDir, "missing-cmd.exe");
          await expect(probeCliRoute("codex", fixture)).resolves.toEqual({
            help: "",
          });
        } finally {
          if (previousComSpec === undefined) {
            delete process.env.ComSpec;
          } else {
            process.env.ComSpec = previousComSpec;
          }
        }
      } finally {
        await fs.rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  const qwenCmdFixture = (contractStderr: string) =>
    [
      "@echo off",
      'if /I "%~1"=="--help" (',
      "  echo Usage: qwen [options] [command]",
      "  echo   -p, --prompt  Prompt  [string]",
      "  exit /b 0",
      ")",
      'if /I "%~1"=="--version" (',
      "  echo 0.22.2",
      "  exit /b 0",
      ")",
      'if /I "%~1"=="--approval-mode" (',
      `  echo ${contractStderr} 1>&2`,
      "  exit /b 1",
      ")",
      "echo unexpected argument: %~1 1>&2",
      "exit /b 1",
    ].join("\r\n");

  it.skipIf(process.platform !== "win32")(
    "treats an empty Qwen approval-mode contract probe as unavailable",
    async () => {
      const fixtureDir = await fs.mkdtemp(
        path.join("D:\\Scratch", "cukii qwen probe "),
      );
      const fixture = path.join(fixtureDir, "qwen.cmd");
      try {
        // A load-killed contract probe prints nothing; the discovery must not
        // survive as a zero-mode capability snapshot.
        await fs.writeFile(fixture, qwenCmdFixture(""));
        await expect(probeCliRoute("qwen", fixture)).resolves.toEqual({
          help: "",
        });
      } finally {
        await fs.rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "parses the full Qwen approval-mode contract from the invalid-flag probe",
    async () => {
      const fixtureDir = await fs.mkdtemp(
        path.join("D:\\Scratch", "cukii qwen probe "),
      );
      const fixture = path.join(fixtureDir, "qwen.cmd");
      try {
        await fs.writeFile(
          fixture,
          qwenCmdFixture(
            'Argument: approval-mode, Given: "", Choices: "plan", "default", "auto-edit", "auto", "yolo"',
          ),
        );
        const probe = await probeCliRoute("qwen", fixture);
        expect(probe.version).toBe("0.22.2");
        expect(
          parseVendorPermissionCapabilities("qwen", probe.help, probe.version)
            .supportedModes,
        ).toEqual(["manual", "editAutomatically", "plan", "auto", "bypass"]);
      } finally {
        await fs.rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );
});

// On macOS/Linux the probe used to resolve the CLI by bare name only, while
// the bridge route tried the Cukii install directories first. A GUI VS Code
// whose PATH comes from the launcher then reported every installed vendor as
// "no verified permission mode" (the Grok card's screenshot) even though the
// route could launch the same binary.
describe("unix vendor CLI probe resolution", () => {
  it("tries the Cukii install directories before PATH on macOS/Linux", () => {
    expect(commandCandidates("grok", "/Users/owner", "darwin")).toEqual([
      "/Users/owner/.local/share/cukii/node/bin/grok",
      "/Users/owner/.local/bin/grok",
      "grok",
    ]);
    expect(commandCandidates("qwen", "/home/owner", "linux")).toEqual([
      "/home/owner/.local/share/cukii/node/bin/qwen",
      "/home/owner/.local/bin/qwen",
      "qwen",
    ]);
  });

  it("keeps the bare name as the last Windows candidate", () => {
    const candidates = commandCandidates(
      "grok",
      "C:\\Users\\owner",
      "win32",
    );
    expect(candidates.at(-1)).toBe("grok");
    expect(candidates).toContain(
      "C:\\Users\\owner\\scoop\\apps\\nodejs\\current\\bin\\grok.cmd",
    );
  });

  it("selects an installed absolute candidate a launcher PATH cannot see", async () => {
    const fixtureDir = await fs.mkdtemp(
      path.join("D:\\Scratch", "cukii probe home "),
    );
    const home = path.join(fixtureDir, "owner");
    const bin = path.join(home, ".local", "bin");
    try {
      await fs.mkdir(bin, { recursive: true });
      const executable = path.join(bin, "grok");
      await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");

      const probe = resolveProbeCommand("grok", home, "darwin");
      expect(probe?.route).toBe(`${home}/.local/bin/grok`);
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("falls back to the bare name when no Cukii install exists", async () => {
    const fixtureDir = await fs.mkdtemp(
      path.join("D:\\Scratch", "cukii probe home "),
    );
    const emptyHome = path.join(fixtureDir, "nobody");
    try {
      const probe = resolveProbeCommand("grok", emptyHome, "darwin");
      expect(probe?.route).toBe("grok");
    } finally {
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
