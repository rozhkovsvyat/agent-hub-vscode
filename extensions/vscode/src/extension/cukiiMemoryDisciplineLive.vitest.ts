import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUKII_RULES_BEGIN,
  disciplineTargets,
  fetchDisciplineBlock,
  installDisciplineBlock,
} from "./cukiiMemoryDiscipline";

/**
 * Runtime proof against the owner's real Cukii Box.
 *
 * 🔴 Unit tests prove the merge; they cannot prove that a live box actually
 * serves the discipline at the path the product asks for. A harness that only
 * tests its own fixtures is how 2.0.133 shipped a connected memory with no
 * discipline and still looked green.
 *
 * Opt-in, so CI and other machines skip it instead of failing on a box they
 * cannot reach: set CUKII_LIVE_BOX_TOKEN (and optionally CUKII_LIVE_BOX_URL).
 */
const token = process.env.CUKII_LIVE_BOX_TOKEN;
const endpoint = process.env.CUKII_LIVE_BOX_URL ?? "https://box.cukii.ru/mcp";

describe.runIf(token)("Cukii discipline against the live box", () => {
  it("serves the discipline and installs it into the agent files", async () => {
    const block = await fetchDisciplineBlock(endpoint, token as string);
    expect(block.startsWith(CUKII_RULES_BEGIN)).toBe(true);
    expect(block).toContain("memory_search");

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-live-home-"));
    try {
      const report = installDisciplineBlock(block, home);
      expect(report.failed).toHaveLength(0);
      expect(report.written).toHaveLength(3);
      for (const target of disciplineTargets(home)) {
        expect(fs.readFileSync(target, "utf8")).toContain("memory_search");
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
