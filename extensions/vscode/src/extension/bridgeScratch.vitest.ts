import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CUKII_BRIDGE_SCRATCH_ROOT,
  CUKII_VOICE_SCRATCH_ROOT,
  bridgeScratchRoot,
  createCukiiScratchDirectory,
  removeBridgeScratchFile,
  removeCukiiScratchDirectory,
  scratchRootFor,
  voiceScratchRoot,
  writeBridgeScratchFile,
} from "./bridgeScratch";

// The Windows roots are fixed volumes (`D:\Scratch\cukii-*`) and the
// hardening here is about Windows junction/reparse points, which do not
// exist on another platform.
describe.runIf(process.platform === "win32")("Cukii Scratch roots", () => {
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

// On POSIX the same roots live under the user home: a literal Windows volume
// would resolve relative to the working directory, litter the checkout with
// `D:` folders and then fail realpath. CI on ubuntu exercises this branch.
describe.skipIf(process.platform === "win32")(
  "Cukii Scratch roots on POSIX",
  () => {
    it("keeps every root private under the user home", () => {
      const privateRoot = path.join(os.homedir(), ".cukii", "scratch");
      for (const root of [
        CUKII_BRIDGE_SCRATCH_ROOT,
        CUKII_VOICE_SCRATCH_ROOT,
      ]) {
        expect(path.isAbsolute(root)).toBe(true);
        expect(root.startsWith(privateRoot + path.sep)).toBe(true);
      }
    });

    it("creates the root 0700 and exclusive 0600 bridge prompts under it", () => {
      const root = bridgeScratchRoot();
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
      const prompt = writeBridgeScratchFile("posix-hardening", "secret prompt");
      try {
        expect(path.dirname(prompt)).toBe(root);
        expect(fs.readFileSync(prompt, "utf8")).toBe("secret prompt");
        expect(fs.statSync(prompt).mode & 0o777).toBe(0o600);
      } finally {
        removeBridgeScratchFile(prompt);
      }
      expect(fs.existsSync(prompt)).toBe(false);
    });

    it("removes only owned direct children", () => {
      const directory = createCukiiScratchDirectory(
        CUKII_VOICE_SCRATCH_ROOT,
        "posix",
      );
      try {
        expect(path.dirname(directory)).toBe(voiceScratchRoot());
      } finally {
        removeCukiiScratchDirectory(directory, CUKII_VOICE_SCRATCH_ROOT);
      }
      expect(() =>
        removeCukiiScratchDirectory(os.homedir(), CUKII_VOICE_SCRATCH_ROOT),
      ).toThrow("outside Cukii Scratch");
    });
  },
);

describe("scratchRootFor Windows ladder", () => {
  const win = "win32" as const;

  it("prefers the canonical D:\\Scratch volume when it exists", () => {
    expect(
      scratchRootFor("bridge", {
        platform: win,
        pathExists: (candidate) => candidate === "D:\\Scratch",
      }),
    ).toBe("D:\\Scratch\\cukii-bridge");
  });

  it("falls back to CUKII_SCRATCH_DIR when the machine has no D: volume", () => {
    expect(
      scratchRootFor("voice", {
        platform: win,
        env: { cukii_scratch_dir: "E:\\cukii-tmp" },
        pathExists: (candidate) => candidate === "E:\\cukii-tmp",
      }),
    ).toBe("E:\\cukii-tmp\\cukii-voice");
  });

  it("falls back to the per-user system temp without D: or an override", () => {
    expect(
      scratchRootFor("permission", {
        platform: win,
        env: {},
        pathExists: () => false,
        tmpdir: "C:\\Users\\stark\\AppData\\Local\\Temp",
      }),
    ).toBe("C:\\Users\\stark\\AppData\\Local\\Temp\\cukii-permission");
  });

  it("ignores a CUKII_SCRATCH_DIR override that does not exist", () => {
    expect(
      scratchRootFor("bridge", {
        platform: win,
        env: { CUKII_SCRATCH_DIR: "E:\\missing" },
        pathExists: () => false,
        tmpdir: "C:\\Temp",
      }),
    ).toBe("C:\\Temp\\cukii-bridge");
  });

  it("keeps POSIX roots private under the user home", () => {
    expect(
      scratchRootFor("bridge", { platform: "linux", homedir: "/home/stark" }),
    ).toBe(path.join("/home/stark", ".cukii", "scratch", "bridge"));
  });
});
