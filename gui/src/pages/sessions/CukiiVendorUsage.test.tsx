import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import type { BrokerVendorId } from "core/cukiiVendorRegistry";
import { renderWithProviders } from "../../util/test/render";
import {
  CukiiVendorUsageDetails,
  CukiiVendorUsageSection,
  observedCopy,
  resetCopy,
} from "./CukiiVendorUsage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Cukii vendor usage Claude parity", () => {
  beforeEach(() => localStorage.clear());

  it("renders no header and occupies no layout when no vendor is selected", async () => {
    const { container } = await renderWithProviders(
      <CukiiVendorUsageSection />,
    );
    expect(
      container.querySelector('[data-testid="cukii-vendor-usage"]'),
    ).toBeNull();
  });

  it("matches the Claude account and usage geometry for the active vendor", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({
        vendor,
        accountLabel: "owner@example.com",
        observedAt: 1_789_400_000,
        windows: [
          {
            id: "five_hour",
            label: "Session (5hr)",
            utilization: 0.48,
            resetsAt: Math.floor(Date.now() / 1_000) + 7_200,
          },
          {
            id: "seven_day",
            label: "Weekly (7 day)",
            utilization: 0.53,
          },
        ],
      }),
    );

    const { container, user } = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="codex-5-6-sol" />,
      { mockIdeMessenger: messenger },
    );

    expect(await screen.findByText("Account & usage")).toBeInTheDocument();
    expect(screen.getByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByText("Session (5hr)")).toBeInTheDocument();
    expect(screen.getByText("48%")).toBeInTheDocument();
    expect(screen.getByText("Weekly (7 day)")).toBeInTheDocument();
    expect(screen.getByText("53%")).toBeInTheDocument();

    const section = container.querySelector(
      '[data-testid="cukii-vendor-usage"]',
    )!;
    expect(section).toHaveAttribute("data-vendor", "codex");
    const body = container.querySelector(
      '[data-testid="cukii-vendor-usage-body"]',
    )!;
    expect(getComputedStyle(body).padding).toBe("10px 12px");
    expect(getComputedStyle(body).gap).toBe("16px");
    const progress = screen.getByRole("progressbar", { name: "Session (5hr)" });
    expect(getComputedStyle(progress.parentElement!).height).toBe("6px");
    expect(progress).toHaveAttribute("aria-valuenow", "48");

    await user.click(screen.getByTitle("Collapse account & usage"));
    expect(
      container.querySelector('[data-testid="cukii-vendor-usage-body"]'),
    ).toBeNull();
    expect(localStorage.getItem("cukii.vendor-usage.collapsed.v1")).toBe("1");
  });

  it("switches the normalized provider with the active chat model", async () => {
    const messenger = new MockIdeMessenger();
    const getUsage = vi.fn(
      async ({ vendor }: { vendor: "claude" | "kimi" }) => ({
        vendor,
        windows: [],
        accountLabel:
          vendor === "claude"
            ? "anthropic@example.com"
            : "moonshot@example.com",
      }),
    );
    messenger.responseHandlers["cukii/getVendorUsage"] = getUsage as never;
    const { container, rerender } = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="opus-5" />,
      { mockIdeMessenger: messenger },
    );
    await screen.findByText("anthropic@example.com");
    expect(
      container.querySelector('[data-testid="cukii-vendor-usage"]'),
    ).toHaveAttribute("data-vendor", "claude");

    rerender(<CukiiVendorUsageSection brokerModel="kimi-k3" />);
    await screen.findByText("moonshot@example.com");
    expect(
      container.querySelector('[data-testid="cukii-vendor-usage"]'),
    ).toHaveAttribute("data-vendor", "kimi");
  });

  it("does not let a slow previous vendor overwrite the newly active one", async () => {
    const messenger = new MockIdeMessenger();
    const claude = deferred<{
      vendor: "claude";
      accountLabel: string;
      windows: [];
    }>();
    messenger.responseHandlers["cukii/getVendorUsage"] = (async ({
      vendor,
    }: {
      vendor: BrokerVendorId;
    }) =>
      vendor === "claude"
        ? claude.promise
        : {
            vendor,
            accountLabel: "current@moonshot.ai",
            windows: [],
          }) as never;
    const { rerender } = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="opus-5" />,
      { mockIdeMessenger: messenger },
    );

    rerender(<CukiiVendorUsageSection brokerModel="kimi-k3" />);
    await screen.findByText("current@moonshot.ai");
    await act(async () => {
      claude.resolve({
        vendor: "claude",
        accountLabel: "stale@anthropic.com",
        windows: [],
      });
      await claude.promise;
    });
    await waitFor(() =>
      expect(screen.queryByText("stale@anthropic.com")).toBeNull(),
    );
  });

  it("opens the detailed usage surface for the exact active vendor", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({
        vendor,
        windows: [],
      }),
    );
    messenger.responses["cukii/openVendorUsageDetails"] = undefined;
    const request = vi.spyOn(messenger, "request");
    const { user } = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="grok-4-6" />,
      { mockIdeMessenger: messenger },
    );
    await user.click(await screen.findByText("View details"));
    expect(request).toHaveBeenCalledWith("cukii/openVendorUsageDetails", {
      vendor: "grok",
    });
  });

  it("matches Claude's modal surface and closes through the owning host", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({
        vendor,
        accountLabel: "owner@example.com",
        windows: [
          {
            id: "five_hour",
            label: "Session (5hr)",
            utilization: 0.48,
          },
        ],
      }),
    );
    messenger.responses["cukii/closeVendorUsageDetails"] = undefined;
    const request = vi.spyOn(messenger, "request");
    const { container, user } = await renderWithProviders(
      <CukiiVendorUsageDetails vendor="claude" />,
      { mockIdeMessenger: messenger },
    );

    await screen.findByText("Account & Usage");
    const root = container.querySelector(
      '[data-testid="cukii-vendor-usage-details"]',
    )!;
    expect(getComputedStyle(root).display).toBe("grid");
    expect(getComputedStyle(root).placeItems).toBe("center");
    await user.click(
      screen.getByRole("button", {
        name: "Close account and usage details",
      }),
    );
    expect(request).toHaveBeenCalledWith(
      "cukii/closeVendorUsageDetails",
      undefined,
    );
  });

  it("renders model-scoped and arbitrary windows for any vendor, not just Claude", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({
        vendor,
        windows: [
          {
            id: "five_hour",
            label: "Session (5hr)",
            utilization: 0.2,
            source: "cli" as const,
          },
          {
            id: "model_scoped",
            label: "Fable limit",
            utilization: 0.12,
            source: "api" as const,
          },
          {
            id: "secondary:120",
            label: "2 hour limit",
            utilization: 0.99,
          },
        ],
      }),
    );

    await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="kimi-k3" />,
      { mockIdeMessenger: messenger },
    );

    expect(await screen.findByText("Fable limit")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("2 hour limit")).toBeInTheDocument();
    expect(screen.getByText("99%")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Fable limit" }),
    ).toHaveAttribute("aria-valuenow", "12");
  });

  it("shows a stable explicit empty state instead of vanishing with no data", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({ vendor, windows: [] }),
    );

    const { container } = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="grok-4-6" />,
      { mockIdeMessenger: messenger },
    );

    expect(
      await screen.findByTestId("cukii-vendor-usage-empty"),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="cukii-vendor-usage"]'),
    ).toHaveAttribute("data-vendor", "grok");
    expect(
      container.querySelector('[data-testid="cukii-vendor-usage-body"]'),
    ).not.toBeNull();
  });

  it("says honestly when the vendor publishes no usage endpoint", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({ vendor, windows: [] }),
    );

    await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="qwen-3-8-max" />,
      { mockIdeMessenger: messenger },
    );

    const honest = await screen.findByTestId("cukii-vendor-usage-no-endpoint");
    expect(honest).toBeInTheDocument();
    expect(honest.textContent).toContain("Alibaba");
    expect(
      screen.queryByTestId("cukii-vendor-usage-empty"),
    ).not.toBeInTheDocument();
  });

  it("repaints the last-known windows from cache while the host re-probes", async () => {
    const first = new MockIdeMessenger();
    first.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({
        vendor,
        observedAt: Math.floor(Date.now() / 1_000),
        windows: [
          { id: "five_hour", label: "Session (5hr)", utilization: 0.48 },
        ],
      }),
    );
    const initial = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="codex-5-6-sol" />,
      { mockIdeMessenger: first },
    );
    expect(await screen.findByText("Session (5hr)")).toBeInTheDocument();
    expect(
      localStorage.getItem("cukii.vendor-usage.snapshot.v1.codex"),
    ).toContain("five_hour");
    initial.unmount();

    // A webview restart whose request is stuck behind the account CLI probe
    // must still paint the previous run's windows immediately.
    const stuck = deferred<{
      vendor: "codex";
      windows: { id: string; label: string; utilization: number }[];
    }>();
    const restarted = new MockIdeMessenger();
    restarted.responseHandlers["cukii/getVendorUsage"] = (() =>
      stuck.promise) as never;
    await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="codex-5-6-sol" />,
      { mockIdeMessenger: restarted },
    );
    expect(screen.getByText("Session (5hr)")).toBeInTheDocument();
    expect(screen.getByText("48%")).toBeInTheDocument();

    // Fresh data replaces the stale paint once the host finally answers.
    await act(async () => {
      stuck.resolve({
        vendor: "codex",
        windows: [
          { id: "five_hour", label: "Session (5hr)", utilization: 0.9 },
        ],
      });
      await stuck.promise;
    });
    expect(await screen.findByText("90%")).toBeInTheDocument();
    expect(screen.queryByText("48%")).toBeNull();
  });

  it("keeps cached snapshots isolated per vendor", async () => {
    localStorage.setItem(
      "cukii.vendor-usage.snapshot.v1.kimi",
      JSON.stringify({
        vendor: "kimi",
        windows: [
          { id: "five_hour", label: "Session (5hr)", utilization: 0.77 },
        ],
      }),
    );
    const messenger = new MockIdeMessenger();
    const pending = deferred<{
      vendor: "claude";
      windows: [];
    }>();
    messenger.responseHandlers["cukii/getVendorUsage"] = (() =>
      pending.promise) as never;

    await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="opus-5" />,
      { mockIdeMessenger: messenger },
    );

    expect(screen.queryByText("77%")).toBeNull();
    expect(screen.getByTestId("cukii-vendor-usage-empty")).toBeInTheDocument();
  });

  it("formats reset times with the same compact Claude copy", () => {
    const now = Date.parse("2026-09-15T20:00:00Z");
    expect(resetCopy(Math.floor(now / 1_000) + 7_200, now)).toBe(
      "Resets in 2h",
    );
    expect(resetCopy(Math.floor(now / 1_000) + 259_200, now)).toBe(
      "Resets in 3d",
    );
    expect(resetCopy(undefined, now)).toBeNull();
  });

  it("describes the snapshot age with compact copy", () => {
    const now = Date.parse("2026-09-15T20:00:00Z");
    const at = Math.floor(now / 1_000);
    expect(observedCopy(at, now)).toBe("Updated just now");
    expect(observedCopy(at - 45 * 60, now)).toBe("Updated 45m ago");
    expect(observedCopy(at - 3 * 3_600, now)).toBe("Updated 3h ago");
    expect(observedCopy(at - 3 * 86_400, now)).toBe("Updated 3d ago");
    expect(observedCopy(undefined, now)).toBeNull();
  });
});
