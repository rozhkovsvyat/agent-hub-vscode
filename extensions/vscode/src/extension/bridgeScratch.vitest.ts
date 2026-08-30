import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUKII_BRIDGE_SCRATCH_ROOT,
  CUKII_VOICE_SCRATCH_ROOT,
  createCukiiScratchDirectory,
  removeBridgeScratchFile,
  removeCukiiScratchDirectory,
  writeBridgeScratchFile,
} from "./bridgeScratch";

describe("Cukii Scratch roots", () => {
  it("creates exclusive bridge prompts and removes only owned direct children", () => {
    const prompt = writeBridgeScratchFile("hardening", "secret prompt");
    try {
      expect(path.dirname(prompt).toLowerCase()).toBe(
        CUKII_BRIDGE_SCRATCH_ROOT.toLowerCase(),
      );
      expect(fs.readFileSync(prompt, "utf8")).toBe("secret prompt");
    } finally {
      removeBridgeScratchFile(prompt);
    }
    expect(fs.existsSync(prompt)).toBe(false);
    expect(() =>
      removeCukiiScratchDirectory("D:\\Scratch", CUKII_VOICE_SCRATCH_ROOT),
    ).toThrow("outside Cukii Scratch");
  });

  it("uses a dedicated voice root rather than the OS temporary directory", () => {
    const directory = createCukiiScratchDirectory(
      CUKII_VOICE_SCRATCH_ROOT,
      "hardening",
    );
    try {
      expect(path.dirname(directory).toLowerCase()).toBe(
        CUKII_VOICE_SCRATCH_ROOT.toLowerCase(),
      );
    } finally {
      removeCukiiScratchDirectory(directory, CUKII_VOICE_SCRATCH_ROOT);
    }
  });
});
