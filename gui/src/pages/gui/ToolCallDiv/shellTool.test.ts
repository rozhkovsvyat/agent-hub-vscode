import { describe, expect, it } from "vitest";
import { isShellToolName, shellCommandFromArgs } from "./shellTool";

describe("shell tool routing", () => {
  it("treats vendor Bash/Shell tools as command cards with IN/OUT (ID-273)", () => {
    expect(isShellToolName("run_terminal_command")).toBe(true);
    expect(isShellToolName("Bash")).toBe(true);
    expect(isShellToolName("Shell")).toBe(true);
    expect(isShellToolName("PowerShell")).toBe(true);
    expect(isShellToolName("Read")).toBe(false);
  });

  it("reads command text from common argument names", () => {
    expect(shellCommandFromArgs({ command: "ls" })).toBe("ls");
    expect(shellCommandFromArgs({ cmd: "pwd" })).toBe("pwd");
    expect(shellCommandFromArgs({ script: "echo hi" })).toBe("echo hi");
    expect(shellCommandFromArgs({})).toBe("");
  });
});
