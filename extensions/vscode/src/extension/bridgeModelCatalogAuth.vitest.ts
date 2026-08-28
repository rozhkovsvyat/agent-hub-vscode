import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAccounts, execFile } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("./bridgeVendorAuth", () => ({
  listBrokerVendorAccounts: listAccounts,
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

    expect(execFile).toHaveBeenCalledWith(
      "agent",
      ["models"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});
