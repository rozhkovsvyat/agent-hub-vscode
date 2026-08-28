import { describe, expect, it } from "vitest";

import { probeCommandForRoute } from "./permissionCapabilities";

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
});
