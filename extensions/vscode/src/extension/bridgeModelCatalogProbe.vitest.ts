import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAccounts, execFile } = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  execFile: vi.fn(),
}));
vi.mock("./bridgeVendorAuth", () => ({
  listBrokerVendorAccounts: listAccounts,
  // What the Windows resolver actually returns: the Cursor CLI ships as a
  // batch wrapper, which is the whole reason the probe route matters.
  resolveNativeCli: (vendor: string) =>
    vendor === "cursor" ? "agent.cmd" : undefined,
}));
vi.mock("child_process", () => ({ execFile }));

import {
  listBrokerModelCatalog,
  resetClaudeCatalogProbeCache,
  staticCatalogForUnavailableDiscovery,
} from "./bridgeModelCatalog";

function claudeModels(
  catalog: Awaited<ReturnType<typeof listBrokerModelCatalog>>,
) {
  return catalog.find((vendor) => vendor.id === "claude")?.models ?? [];
}

function failEveryCliProbe(): void {
  execFile.mockImplementation(
    (
      _program: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string }) => void,
    ) => {
      callback(new Error("spawn claude ENOENT"));
    },
  );
}

function answerClaudeVersion(version: string): void {
  execFile.mockImplementation(
    (
      _program: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, result?: { stdout: string }) => void,
    ) => {
      if (args.includes("--version")) {
        callback(null, { stdout: `${version} (Claude Code)` });
        return;
      }
      callback(new Error(`unexpected probe args: ${args.join(" ")}`));
    },
  );
}

describe("Claude catalog refresh probe", () => {
  beforeEach(() => {
    listAccounts.mockReset();
    execFile.mockReset();
    resetClaudeCatalogProbeCache();
    listAccounts.mockResolvedValue([
      { id: "claude", state: "connected" },
      { id: "codex", state: "disconnected" },
      { id: "grok", state: "disconnected" },
      { id: "cursor", state: "disconnected" },
      { id: "kimi", state: "disconnected" },
      { id: "qwen", state: "disconnected" },
      { id: "deepseek", state: "disconnected" },
    ]);
  });

  it("falls back to the maintained catalog when the Claude CLI probe cannot run", async () => {
    failEveryCliProbe();
    const catalog = await listBrokerModelCatalog();
    const models = claudeModels(catalog);
    expect(models).toEqual(staticCatalogForUnavailableDiscovery("claude"));
    expect(models).toContainEqual(
      expect.objectContaining({ value: "fable-5-1", label: "Fable 5.1" }),
    );
  });

  it("hides Fable 5.1 while the installed CLI predates its minimum build", async () => {
    answerClaudeVersion("2.1.202");
    const catalog = await listBrokerModelCatalog();
    const values = claudeModels(catalog).map((model) => model.value);
    expect(values).not.toContain("fable-5-1");
    expect(values).toContain("opus-5");
  });

  it("surfaces Fable 5.1 once the installed CLI reaches its minimum build", async () => {
    answerClaudeVersion("2.1.258");
    const catalog = await listBrokerModelCatalog();
    expect(claudeModels(catalog)).toContainEqual(
      expect.objectContaining({ value: "fable-5-1", label: "Fable 5.1" }),
    );
  });

  it("serves repeated picker opens from the TTL cache instead of re-probing", async () => {
    answerClaudeVersion("2.1.258");
    await listBrokerModelCatalog();
    const probeCalls = execFile.mock.calls.length;
    expect(probeCalls).toBeGreaterThan(0);

    const second = await listBrokerModelCatalog();
    expect(execFile.mock.calls.length).toBe(probeCalls);
    expect(claudeModels(second)).toContainEqual(
      expect.objectContaining({ value: "fable-5-1" }),
    );

    resetClaudeCatalogProbeCache();
    await listBrokerModelCatalog();
    expect(execFile.mock.calls.length).toBeGreaterThan(probeCalls);
  });

  it("never probes the CLI for a disconnected Claude account", async () => {
    listAccounts.mockResolvedValue([{ id: "claude", state: "disconnected" }]);
    failEveryCliProbe();
    const catalog = await listBrokerModelCatalog();
    expect(claudeModels(catalog)).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("runs the Cursor CLI through the command processor, not as a bare program", async () => {
    // The resolved Cursor CLI on Windows is `agent.cmd`, and since Node's
    // batch-injection fix a .cmd cannot be spawned without a shell: execFile
    // throws `spawn EINVAL`, the probe's catch turns that into an empty
    // catalog, and Cursor's models vanish from the picker while its CLI is
    // installed and logged in. Every other vendor already goes through the
    // command processor; this pins Cursor to the same route.
    listAccounts.mockResolvedValue([{ id: "cursor", state: "connected" }]);
    execFile.mockImplementation(
      (
        program: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, result?: { stdout: string }) => void,
      ) => {
        if (/\.(cmd|bat)$/i.test(program)) {
          const failure = new Error("spawn EINVAL") as Error & {
            code?: string;
          };
          failure.code = "EINVAL";
          callback(failure);
          return;
        }
        if (args.includes("models")) {
          callback(null, {
            stdout: "Available models\n\ncomposer-2.5 - Composer 2.5\n",
          });
          return;
        }
        callback(new Error(`unexpected probe args: ${args.join(" ")}`));
      },
    );

    const catalog = await listBrokerModelCatalog();
    const cursor = catalog.find((vendor) => vendor.id === "cursor");
    expect(cursor?.models).toContainEqual(
      expect.objectContaining({ label: "Composer 2.5" }),
    );
    const probe = execFile.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes("models"),
    );
    expect(probe?.[1]).toEqual(["/d", "/c", "agent.cmd", "models"]);
  });
});
