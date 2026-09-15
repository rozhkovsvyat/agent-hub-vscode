import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

const messengerSource = fs.readFileSync(
  path.join(__dirname, "VsCodeMessenger.ts"),
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
    expect(messengerSource).toContain(
      'flow.outcome === "command-failed"',
    );
    expect(messengerSource).toContain(
      "CLI installation failed. Fix the error shown in the terminal, then select Install again.",
    );
  });

  it("creates install terminals with the platform-specific shell plan", () => {
    expect(messengerSource).toContain(
      "{ shellPath: spec.shellPath, shellArgs: spec.shellArgs }",
    );
  });
});
