import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { PermissionModeControl } from "./PermissionModeControl";

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

  it("stays hidden when the exact-route probe rejects", async () => {
    const messenger = new MockIdeMessenger();
    messenger.responseHandlers["cukii/getPermissionCapabilities"] = vi.fn(
      async () => {
        throw new Error("probe rejected");
      },
    );
    await renderWithProviders(
      <PermissionModeControl
        brokerModel="opus-5"
        permissionMode="bypass"
        onChange={vi.fn()}
      />,
      { mockIdeMessenger: messenger },
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Toggle permission mode" }),
      ).toBeNull(),
    );
  });
});
