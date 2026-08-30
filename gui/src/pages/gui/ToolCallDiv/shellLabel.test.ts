import { describe, expect, it } from "vitest";
import { commandShellLabel } from "./shellLabel";

describe("commandShellLabel", () => {
  it("prefers trusted event metadata", () => {
    expect(commandShellLabel("echo portable", "pwsh.exe")).toBe("PowerShell");
    expect(commandShellLabel("Write-Output nope", "/bin/bash")).toBe("Bash");
  });

  it.each([
    "Write-Output hi",
    "Test-Path D:\\repo",
    "Start-Sleep -Seconds 1",
    "Import-Module Pester",
    "$items = Get-ChildItem",
    "& 'D:\\tools\\check.ps1'",
  ])("detects common PowerShell without calling it Bash: %s", (command) => {
    expect(commandShellLabel(command)).toBe("PowerShell");
  });

  it.each(["#!/bin/bash\necho ok", "export NODE_ENV=test", "chmod +x run.sh", "ls -la"])(
    "detects explicit Bash syntax: %s",
    (command) => expect(commandShellLabel(command)).toBe("Bash"),
  );

  it("uses an honest neutral label for ambiguous commands", () => {
    expect(commandShellLabel("npm test")).toBe("Shell");
    expect(commandShellLabel("echo hello")).toBe("Shell");
  });
});
