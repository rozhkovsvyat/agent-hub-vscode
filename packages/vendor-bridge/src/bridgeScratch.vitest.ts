import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  bridgeScratchRoot,
  bridgeScratchRootPath,
  createCukiiScratchDirectory,
  createDirectoryWithoutReparse,
  permissionScratchRootPath,
  removeBridgeScratchFile,
  removeCukiiScratchDirectory,
  voiceScratchRoot,
  voiceScratchRootPath,
  windowsScratchBase,
  writeBridgeScratchFile,
} from "./bridgeScratch";
import { configureBridgeStorageHost } from "./bridgeStorageEnv";

// The library default is machine-free; the host values the plugin pins are
// configured here so the ladder assertions exercise the same contract.
configureBridgeStorageHost({
  preferredWindowsScratchRoot: "D:\\Scratch",
});

const CUKII_BRIDGE_SCRATCH_ROOT = bridgeScratchRootPath();
const CUKII_PERMISSION_SCRATCH_ROOT = permissionScratchRootPath();
const CUKII_VOICE_SCRATCH_ROOT = voiceScratchRootPath();

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

  // Card CUK-112: the Windows root was the literal `D:\Scratch\cukii-*`, so on
  // a machine with no D: volume every vendor — not only Grok — died before it
  // started with `ENOENT: no such file or directory, mkdir 'D:\Scratch'`.
  it("derives the Windows root from the shared ladder, not a fixed volume", () => {
    const base = windowsScratchBase();
    expect(path.win32.isAbsolute(base)).toBe(true);
    for (const [root, name] of [
      [CUKII_BRIDGE_SCRATCH_ROOT, "bridge"],
      [CUKII_PERMISSION_SCRATCH_ROOT, "permission"],
      [CUKII_VOICE_SCRATCH_ROOT, "voice"],
    ] as const) {
      expect(root).toBe(path.win32.join(base, `cukii-${name}`));
    }

    // The volume the owner actually has still wins, or this "fix" would move
    // his bridge artefacts into %TEMP% on the machine that was never broken.
    if (fs.existsSync("D:\\Scratch")) {
      expect(base).toBe("D:\\Scratch");
    }

    // The fallback rung has to be creatable by the very function that failed:
    // a root under the system temporary directory, made without following a
    // reparse point.
    const fallback = path.join(os.tmpdir(), "cukii-scratch-ladder-probe");
    try {
      const created = createDirectoryWithoutReparse(fallback);
      expect(fs.lstatSync(created).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(fallback, { recursive: true, force: true });
    }
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
