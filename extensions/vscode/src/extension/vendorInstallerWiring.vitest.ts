import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const messengerSource = fs.readFileSync(
  path.join(__dirname, "VsCodeMessenger.ts"),
  "utf8",
);
const authSource = fs.readFileSync(
  path.join(__dirname, "bridgeVendorAuth.ts"),
  "utf8",
);
const bridgeSource = fs.readFileSync(
  path.join(__dirname, "bridgeChatAdapter.ts"),
  "utf8",
);

describe("vendor installer host wiring", () => {
  it("subscribes to a fast terminal close before sending the install command", () => {
    const subscribe = messengerSource.indexOf(
      'const closed = new Promise<"terminal-closed">',
    );
    const execute = messengerSource.indexOf(
      "shellIntegration.executeCommand(command)",
    );
    const fallback = messengerSource.indexOf(
      "terminal.sendText(spec.command, true)",
    );

    expect(subscribe).toBeGreaterThan(0);
    expect(subscribe).toBeLessThan(execute);
    expect(subscribe).toBeLessThan(fallback);
  });

  it("turns a closed failed install into a terminal response instead of the cap", () => {
    expect(messengerSource).toContain(
      "closed.then(() => vendorInstallTerminalOutcome(vendor))",
    );
    expect(messengerSource).toContain('flow.outcome === "command-failed"');
    expect(messengerSource).toContain(
      "CLI installation failed. Fix the error shown in the terminal, then select Install again.",
    );
  });

  it("runs finite installers as captured processes and keeps terminals for interactive auth only", () => {
    const installBranch = messengerSource.indexOf('action === "install"');
    const processRun = messengerSource.indexOf(
      "runVendorInstallProcess(spec",
      installBranch,
    );
    const terminal = messengerSource.indexOf(
      "vscode.window.createTerminal",
      installBranch,
    );

    expect(installBranch).toBeGreaterThan(0);
    expect(processRun).toBeGreaterThan(installBranch);
    expect(terminal).toBeGreaterThan(processRun);
    expect(messengerSource).toContain(
      "The full installer output is open in the Output panel.",
    );
  });
});

// Three call sites launch a vendor CLI after the install, and in 2.0.132 all
// three trusted the host PATH. On the owner's Mac that PATH has no `node` at
// all, so an npm-shim CLI died in its own shebang: the accounts row reported
// "Account status unavailable", the login terminal printed `env: node: No
// such file or directory`, and the chat bridge could not resolve the CLI it
// had just installed. They share one env rule so they cannot drift apart.
describe("vendor CLI launch environment", () => {
  it("probes account status with the private runtime on PATH", () => {
    const probe = authSource.indexOf(
      "export async function probeVendorExecutable",
    );
    const spawn = authSource.indexOf("await execFileAsync(spec.program", probe);
    const env = authSource.indexOf("env: vendorSpawnEnv()", spawn);

    expect(probe).toBeGreaterThan(0);
    expect(spawn).toBeGreaterThan(probe);
    expect(env).toBeGreaterThan(spawn);
  });

  // Candidate resolution itself is covered behaviourally by
  // `unix vendor CLI resolution` in bridgeRouteArgs.vitest. What only source
  // order can pin is that the spawn environment comes from the shared rule
  // rather than a second copy of it growing here.
  it("builds the bridge PATH from the shared vendor rule", () => {
    expect(bridgeSource).toContain(
      'vendorSpawnEnv({ PATH: segments.join(":") }, home).PATH',
    );
    expect(bridgeSource).not.toMatch(
      /appendPathSegment\(\s*segments,\s*path\.join\(home, "\.local", "share"/,
    );
  });

  it("opens login and logout terminals with the shared vendor PATH", () => {
    const terminal = messengerSource.indexOf(
      "vscode.window.createTerminal",
      messengerSource.indexOf('action === "install"'),
    );
    const env = messengerSource.indexOf("env: vendorSpawnEnv()", terminal);
    const show = messengerSource.indexOf("terminal.show()", terminal);

    expect(terminal).toBeGreaterThan(0);
    expect(env).toBeGreaterThan(terminal);
    expect(env).toBeLessThan(show);
  });

  it("does not let a macOS login shell replace the vendor PATH", () => {
    expect(authSource).toContain('shellPath: "/bin/sh"');
    expect(authSource).toContain(`PATH=\${quotedNode}:"$PATH"`);
    expect(authSource).toContain("path_helper");
  });

  // A missing interpreter does not fail the spawn: the kernel runs
  // `/usr/bin/env`, which exits 127 on its own, so the preflight saw success
  // and the real cause reached the owner as an opaque dead stream.
  it("names a CLI that spawns but cannot execute instead of passing it", () => {
    expect(bridgeSource).toContain(
      "if (probe.status === 126 || probe.status === 127)",
    );
    expect(bridgeSource).toContain("could not be executed");
  });
});
