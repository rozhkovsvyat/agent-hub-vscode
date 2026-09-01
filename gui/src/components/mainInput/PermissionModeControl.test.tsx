import { screen, waitFor } from "@testing-library/react";
import type { CukiiPermissionMode } from "core/cukiiPermissionModes";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import {
  PERMISSION_PROBE_RETRY_MS,
  PermissionModeControl,
  setPermissionProbeRetryMsForTests,
} from "./PermissionModeControl";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("PermissionModeControl route snapshots", () => {
  it("hides stale rows immediately across Qwen→Opus→Qwen and ignores a late probe", async () => {
    const messenger = new MockIdeMessenger();
    const claude = deferred<any>();
    let qwenGeneration = 0;
    messenger.responseHandlers["cukii/getPermissionCapabilities"] = vi.fn(
      async ({ vendor }) => {
        if (vendor === "claude") return claude.promise;
        qwenGeneration += 1;
        return {
          vendor: "qwen",
          supportedModes: ["plan", "bypass"],
          route: "C:/qwen.cmd",
          generation: qwenGeneration,
          helpSource: "live qwen",
        };
      },
    );
    const onChange = vi.fn();
    const view = await renderWithProviders(
      <PermissionModeControl
        brokerModel="qwen3.8-max"
        permissionMode="bypass"
        onChange={onChange}
      />,
      { mockIdeMessenger: messenger },
    );
    expect(
      await screen.findByRole("button", { name: "Toggle permission mode" }),
    ).toBeInTheDocument();

    view.rerender(
      <PermissionModeControl
        brokerModel="opus-5"
        permissionMode="bypass"
        onChange={onChange}
      />,
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Toggle permission mode" }),
      ).toBeNull(),
    );

    view.rerender(
      <PermissionModeControl
        brokerModel="qwen3.8-max"
        permissionMode="bypass"
        onChange={onChange}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Toggle permission mode" }),
    ).toBeInTheDocument();
    claude.resolve({
      vendor: "claude",
      supportedModes: ["manual"],
      route: "C:/claude.exe",
      generation: 9,
      helpSource: "late claude",
    });
    await Promise.resolve();
    expect(screen.getByText("Bypass permissions")).toBeInTheDocument();
    expect(screen.queryByText("Manual")).toBeNull();
  });

  it("keeps the current mode reachable when the probe rejects and never demotes it", async () => {
    setPermissionProbeRetryMsForTests(60_000);
    try {
      const messenger = new MockIdeMessenger();
      messenger.responseHandlers["cukii/getPermissionCapabilities"] = vi.fn(
        async () => {
          throw new Error("probe rejected");
        },
      );
      const onChange = vi.fn();
      await renderWithProviders(
        <PermissionModeControl
          brokerModel="opus-5"
          permissionMode="bypass"
          onChange={onChange}
        />,
        { mockIdeMessenger: messenger },
      );
      expect(
        await screen.findByRole("button", {
          name: "Toggle permission mode",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("Bypass permissions")).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      setPermissionProbeRetryMsForTests(PERMISSION_PROBE_RETRY_MS);
    }
  });

  it("preserves the selected mode on an empty snapshot and explains the degradation", async () => {
    setPermissionProbeRetryMsForTests(60_000);
    try {
      const messenger = new MockIdeMessenger();
      messenger.responseHandlers["cukii/getPermissionCapabilities"] = vi.fn(
        async ({ vendor }) => ({
          vendor,
          supportedModes: [] as CukiiPermissionMode[],
          generation: 1,
          helpSource: "unavailable-route",
        }),
      );
      const onChange = vi.fn();
      const { user } = await renderWithProviders(
        <PermissionModeControl
          brokerModel="qwen3.8-max"
          permissionMode="bypass"
          onChange={onChange}
        />,
        { mockIdeMessenger: messenger },
      );

      expect(
        await screen.findByRole("button", {
          name: "Toggle permission mode",
        }),
      ).toBeInTheDocument();
      expect(screen.getByText("Bypass permissions")).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole("button", { name: "Toggle permission mode" }),
      );
      expect(
        await screen.findByTestId("cukii-permission-degraded-note"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("cukii-permission-mode-bypass"),
      ).not.toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      setPermissionProbeRetryMsForTests(PERMISSION_PROBE_RETRY_MS);
    }
  });

  it("heals discovery on retry and offers the verified rows", async () => {
    setPermissionProbeRetryMsForTests(10);
    try {
      const messenger = new MockIdeMessenger();
      let calls = 0;
      messenger.responseHandlers["cukii/getPermissionCapabilities"] = vi.fn(
        async ({ vendor }) => {
          calls += 1;
          if (calls === 1) {
            return {
              vendor,
              supportedModes: [] as CukiiPermissionMode[],
              generation: 1,
              helpSource: "unavailable-route",
            };
          }
          return {
            vendor,
            supportedModes: ["plan", "bypass"] as CukiiPermissionMode[],
            generation: 2,
            helpSource: "live qwen",
          };
        },
      );
      const onChange = vi.fn();
      const { user } = await renderWithProviders(
        <PermissionModeControl
          brokerModel="qwen3.8-max"
          permissionMode="bypass"
          onChange={onChange}
        />,
        { mockIdeMessenger: messenger },
      );

      expect(
        await screen.findByRole("button", {
          name: "Toggle permission mode",
        }),
      ).toBeInTheDocument();
      await waitFor(() => expect(calls).toBeGreaterThan(1));

      await user.click(
        screen.getByRole("button", { name: "Toggle permission mode" }),
      );
      expect(
        await screen.findByTestId("cukii-permission-mode-plan"),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("cukii-permission-mode-bypass"),
      ).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      setPermissionProbeRetryMsForTests(PERMISSION_PROBE_RETRY_MS);
    }
  });
});
