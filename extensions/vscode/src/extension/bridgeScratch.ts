import fs from "node:fs";
import path from "node:path";

/**
 * Cukii bridge IPC/transcripts/logs are machine-local scratch artefacts.
 * They must never land in a vault, the repository, or the shared OS temp
 * directory where they become visible as unrelated timeline receipts.
 */
export const CUKII_BRIDGE_SCRATCH_ROOT = "D:\\Scratch\\cukii-bridge";
export const CUKII_STEER_SCRATCH_ROOT = "D:\\Scratch\\cukii-steer";

export function bridgeScratchRoot(): string {
  const root = path.resolve(CUKII_BRIDGE_SCRATCH_ROOT);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function createBridgeScratchPath(
  prefix: string,
  extension: ".txt" | ".log" = ".txt",
): string {
  const safePrefix = prefix.replace(/[^a-z0-9._-]/gi, "-");
  return path.join(
    bridgeScratchRoot(),
    `${safePrefix}-${Date.now()}-${Math.random().toString(16).slice(2)}${extension}`,
  );
}

export function steerScratchRoot(): string {
  const root = path.resolve(CUKII_STEER_SCRATCH_ROOT);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function createSteerScratchPath(nonce: string): string {
  return path.join(steerScratchRoot(), `cukii-steer-${nonce}.txt`);
}
