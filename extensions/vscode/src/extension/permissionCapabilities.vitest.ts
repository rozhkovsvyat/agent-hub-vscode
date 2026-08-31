import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseVendorPermissionCapabilities } from "core/cukiiPermissionModes";

import { probeCliRoute, probeCommandForRoute } from "./permissionCapabilities";

describe("native permission capability probing", () => {
  it("runs a Windows .cmd probe through ComSpec without shell mode", () => {
    const probe = probeCommandForRoute(
      "C:\\Users\\owner\\scoop\\apps\\nodejs\\current\\bin\\claude.cmd",
    );
    expect(probe.program.toLowerCase()).toContain("cmd.exe");
    expect(probe.argsPrefix).toEqual([
      "/d",
      "/s",
      "/c",
      'call "C:\\Users\\owner\\scoop\\apps\\nodejs\\current\\bin\\claude.cmd"',
    ]);
  });

  it("does not route the native Cursor probe through WSL", () => {
    const probe = probeCommandForRoute(
      "C:\\Users\\owner\\.cursor\\bin\\agent.exe",
    );
    expect(probe.program).toContain("agent.exe");
    expect(probe.argsPrefix).toEqual([]);
  });

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
      } finally {
        await fs.rm(fixtureDir, { recursive: true, force: true });
      }
    },
  );
});
