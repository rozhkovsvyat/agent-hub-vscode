import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { brokerFactDisciplineDirective } from "./bridgeFactDiscipline";

describe("broker fact discipline", () => {
  it("requires evidence before access, permission, flag and runtime claims", () => {
    const directive = brokerFactDisciplineDirective().join(" ");

    expect(directive).toMatch(/access/i);
    expect(directive).toMatch(/permissions/i);
    expect(directive).toMatch(/feature flags/i);
    expect(directive).toMatch(/authoritative source|tool/i);
    expect(directive).toMatch(/owner.*direct statement/i);
    expect(directive).toMatch(/retract/i);
    expect(directive).toMatch(/never infer/i);
  });

  it("injects the directive into every native broker prompt", () => {
    const adapter = fs.readFileSync(
      path.join(__dirname, "bridgeChatAdapter.ts"),
      "utf8",
    );

    expect(adapter).toContain("...brokerFactDisciplineDirective(),");
  });
});
