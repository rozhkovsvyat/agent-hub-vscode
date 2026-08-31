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
      "/v:off",
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
});
