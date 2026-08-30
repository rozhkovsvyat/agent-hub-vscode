import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CUKII_BRIDGE_SCRATCH_ROOT,
  createKimiPromptScratchFile,
  setBridgeScratchRaceHookForTest,
} from "./bridgeScratch";

afterEach(() => setBridgeScratchRaceHookForTest(undefined));

describe("owned Kimi bridge Scratch", () => {
  it("uses an owner-only Scratch directory and never unlinks a replacement", () => {
    const prompt = createKimiPromptScratchFile(
      "large \u043f\u0440\u043e\u043c\u043f\u0442\n".repeat(10_000),
    );
    expect(prompt.path.toLowerCase()).toContain(
      CUKII_BRIDGE_SCRATCH_ROOT.toLowerCase(),
    );
    expect(fs.readFileSync(prompt.path, "utf8")).toContain(
      "\u043f\u0440\u043e\u043c\u043f\u0442",
    );

    fs.unlinkSync(prompt.path);
    fs.writeFileSync(prompt.path, "outside-canary", "utf8");
    prompt.cleanup();

    expect(fs.readFileSync(prompt.path, "utf8")).toBe("outside-canary");
    fs.rmSync(path.dirname(prompt.path), { recursive: true, force: true });
  });

  it("offers a deterministic replacement race hook without writing outside Scratch", () => {
    let hookPath = "";
    setBridgeScratchRaceHookForTest((phase, candidate) => {
      if (phase !== "after-create") return;
      hookPath = candidate;
      fs.unlinkSync(candidate);
      fs.writeFileSync(candidate, "race-canary", "utf8");
    });
    const prompt = createKimiPromptScratchFile("prompt");
    prompt.cleanup();
    expect(hookPath.toLowerCase()).toContain(
      CUKII_BRIDGE_SCRATCH_ROOT.toLowerCase(),
    );
    expect(fs.readFileSync(hookPath, "utf8")).toBe("race-canary");
    fs.rmSync(path.dirname(hookPath), { recursive: true, force: true });
  });
});
