import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAccounts, execFile } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("./bridgeVendorAuth", () => ({
  listBrokerVendorAccounts: listAccounts,
  resolveNativeCli: (vendor: string) =>
    vendor === "cursor" ? "agent" : undefined,
}));
vi.mock("child_process", () => ({ execFile }));

import {
  ensureCursorCatalogVariants,
  listBrokerModelCatalog,
} from "./bridgeModelCatalog";

describe("account-scoped model discovery", () => {
  beforeEach(() => {
    listAccounts.mockReset();
    execFile.mockReset();
  });

  it("returns no discovery/cache models for every disconnected vendor", async () => {
    listAccounts.mockResolvedValue(
      ["claude", "codex", "grok", "cursor", "kimi", "qwen", "deepseek"].map(
        (id) => ({ id, state: "disconnected" }),
      ),
    );
    const catalog = await listBrokerModelCatalog();
    expect(catalog).toHaveLength(7);
    expect(catalog.every((vendor) => vendor.models.length === 0)).toBe(true);
  });

  it("does not invoke native Cursor discovery for a restored session when signed out", async () => {
    listAccounts.mockResolvedValue([{ id: "cursor", state: "disconnected" }]);

    await expect(
      ensureCursorCatalogVariants("cursor:restored-family"),
    ).rejects.toThrow(/Cursor is not signed in/);

    expect(execFile).not.toHaveBeenCalled();
  });

  it("does not invoke native Cursor discovery for unknown account state", async () => {
    listAccounts.mockResolvedValue([{ id: "cursor", state: "unknown" }]);

    await expect(
      ensureCursorCatalogVariants("cursor:unknown-family"),
    ).rejects.toThrow(/Cursor is not signed in/);

    expect(execFile).not.toHaveBeenCalled();
  });

  it("follows a Cursor family that the vendor renamed under its own prefix", async () => {
    listAccounts.mockResolvedValue([{ id: "cursor", state: "connected" }]);
    execFile.mockImplementation(
      (
        _program: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) =>
        callback(null, {
          stdout: [
            "cursor-grok-4.6-low - Cursor Grok 4.6 Low",
            "cursor-grok-4.6-high - Cursor Grok 4.6",
          ].join("\n"),
        }),
    );

    // Cursor renamed `grok-4.6` to `cursor-grok-4.6` in place. A session saved
    // before the rename used to hard-fail and demand a manual re-pick.
    await expect(
      ensureCursorCatalogVariants("cursor:grok-4.6"),
    ).resolves.toBeUndefined();
  });

  it("still refuses a saved family that is not merely a rename", async () => {
    listAccounts.mockResolvedValue([{ id: "cursor", state: "connected" }]);
    execFile.mockImplementation(
      (
        _program: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => callback(null, { stdout: "cursor-grok-4.6-high - Cursor Grok 4.6" }),
    );

    await expect(
      ensureCursorCatalogVariants("cursor:composer-9.9"),
    ).rejects.toThrow(/no longer exposes/);
  });

  it("allows a connected native Cursor account to use restored variants", async () => {
    listAccounts.mockResolvedValue([{ id: "cursor", state: "connected" }]);
    execFile.mockImplementation(
      (
        _program: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string }) => void,
      ) => callback(null, { stdout: "auto - Auto" }),
    );

    await expect(
      ensureCursorCatalogVariants("cursor:restored-family"),
    ).rejects.toThrow(/no longer exposes/);

    // Through the command processor, like grok and kimi: the real Cursor CLI
    // resolves to a .cmd, which Node refuses to spawn directly since the
    // batch-injection fix.
    expect(execFile).toHaveBeenCalledWith(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", "agent", "models"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});
