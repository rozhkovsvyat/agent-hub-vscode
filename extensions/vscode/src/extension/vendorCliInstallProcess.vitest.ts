import { describe, expect, it } from "vitest";
import {
  runVendorInstallProcess,
  vendorInstallProcessArgs,
} from "./vendorCliInstallProcess";
import {
  vendorInstallTerminalSpec,
  type VendorInstallTerminalSpec,
} from "./vendorCliInstaller";

function spec(command: string): VendorInstallTerminalSpec {
  return {
    name: "test",
    command,
    shellPath: process.execPath,
    shellArgs: [],
    closesTerminal: true,
  };
}

describe("vendor install process", () => {
  it("builds platform-specific non-interactive shell arguments", () => {
    expect(vendorInstallProcessArgs(spec("echo ok"), "darwin")).toEqual([
      "-c",
      "echo ok",
    ]);
    expect(vendorInstallProcessArgs(spec("Write-Output ok"), "win32")).toEqual([
      "-Command",
      "Write-Output ok",
    ]);
  });

  it("preserves stdout, stderr, and a failing exit code", async () => {
    const chunks: string[] = [];
    const base = vendorInstallTerminalSpec("grok", process.platform)!;
    const command =
      process.platform === "win32"
        ? "[Console]::Out.WriteLine('visible-out'); [Console]::Error.WriteLine('visible-error'); exit 37"
        : "printf 'visible-out\\n'; printf 'visible-error\\n' >&2; exit 37";
    const result = await runVendorInstallProcess(
      { ...base, command },
      {
        platform: process.platform,
        onOutput: (chunk) => chunks.push(chunk),
      },
    );

    expect(result).toMatchObject({ exitCode: 37, signal: null });
    expect(chunks.join("")).toContain("visible-out");
    expect(chunks.join("")).toContain("visible-error");
  });
});
