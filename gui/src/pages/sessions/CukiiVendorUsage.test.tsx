import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import type { BrokerVendorId } from "core/cukiiVendorRegistry";
import { renderWithProviders } from "../../util/test/render";
import {
  CukiiVendorUsageDetails,
  CukiiVendorUsageSection,
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

  /**
   * 22.09.2026 сайдбар у grok показывал ровно «Account status unavailable» и
   * больше ничего, тогда как сам CLI снаружи отвечал «You are logged in». Ряд
   * обязан нести причину, иначе владелец упирается в строку, которая одинакова
   * на любой отказ.
   */
  it("shows why the account line could not be decided", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({
        vendor,
        accountLabel: "Account status unavailable",
        statusDetail:
          "C:\\Users\\owner\\.grok\\bin\\grok.exe failed to report a status: spawn ETIMEDOUT",
        windows: [],
      }),
    );

    const { container } = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="grok-4-6" />,
      { mockIdeMessenger: messenger },
    );

    await screen.findByText("Account status unavailable");
    const detail = container.querySelector(
      '[data-testid="cukii-vendor-usage-status-detail"]',
    )!;
    expect(detail).toBeInTheDocument();
    expect(detail.textContent).toContain("spawn ETIMEDOUT");
    expect(detail).toHaveAttribute(
      "title",
      "C:\\Users\\owner\\.grok\\bin\\grok.exe failed to report a status: spawn ETIMEDOUT",
    );
  });

  it("keeps the account block silent when the probe decided cleanly", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
      async ({ vendor }) => ({
        vendor,
        accountLabel: "owner@example.com",
        windows: [],
      }),
    );

    const { container } = await renderWithProviders(
      <CukiiVendorUsageSection brokerModel="grok-4-6" />,
      { mockIdeMessenger: messenger },
    );

    await screen.findByText("owner@example.com");
    expect(
      container.querySelector(
        '[data-testid="cukii-vendor-usage-status-detail"]',
      ),
    ).toBeNull();
  });

  /**
   * Различающая пара к залипанию: хост сперва не смог решить, потом решил.
   * Владелец не должен ничего нажимать — вкладка подробностей, смонтированная
   * позже, в тот день показывала правду, а сайдбар продолжал врать.
   */
  it("asks again after a probe that could not decide", async () => {
    vi.useFakeTimers();
    try {
      const messenger = new MockIdeMessenger();
      let call = 0;
      messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
        async ({ vendor }) => {
          call += 1;
          return call === 1
            ? {
                vendor,
                accountLabel: "Account status unavailable",
                statusDetail: "the probe failed: spawn ETIMEDOUT",
                windows: [],
              }
            : { vendor, accountLabel: "owner@example.com", windows: [] };
        },
      );

      await renderWithProviders(
        <CukiiVendorUsageSection brokerModel="grok-4-6" />,
        { mockIdeMessenger: messenger },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        screen.getByText("Account status unavailable"),
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(screen.getByText("owner@example.com")).toBeInTheDocument();
      expect(screen.queryByText("Account status unavailable")).toBeNull();
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("NEGATIVE CONTROL: does not re-ask after a probe that decided", async () => {
    vi.useFakeTimers();
    try {
      const messenger = new MockIdeMessenger();
      let call = 0;
      messenger.responseHandlers["cukii/getVendorUsage"] = vi.fn(
        async ({ vendor }) => {
          call += 1;
          // «Не залогинен» — это решение, а не осечка: переспрашивать нечего.
          return { vendor, accountLabel: "Not logged in", windows: [] };
        },
      );

      await renderWithProviders(
        <CukiiVendorUsageSection brokerModel="grok-4-6" />,
        { mockIdeMessenger: messenger },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(call).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
});
