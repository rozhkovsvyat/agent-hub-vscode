import { describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import type { BrokerVendorAuthStatus } from "core/protocol/ideWebview";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { getElementByText } from "../../util/test/utils";
import { VendorAccountsModal } from "./VendorAccountsModal";

function deferred<T>() {
  let resolver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolver = complete;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolver) throw new Error("Deferred promise was not initialized");
      resolver(value);
    },
  };
}

function connectedAccount(accountLabel: string): BrokerVendorAuthStatus {
  return {
    id: "codex",
    label: "OpenAI",
    installed: true,
    authenticated: true,
    state: "connected",
    accountLabel,
    actions: ["logout"],
  };
}

describe("VendorAccountsModal", () => {
  it("shows native CLI accounts and opens the requested auth flow", async () => {
    const { ideMessenger, user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
    );
    const requestSpy = vi.spyOn(ideMessenger, "request");

    await getElementByText("Anthropic");
    await getElementByText("DeepSeek");
    await getElementByText("owner@example.com");
    await getElementByText("Coming soon");
    expect(document.querySelectorAll("h3, h4")).toHaveLength(1);
    expect(getElementByText("Accounts")).toBeDefined();
    await user.click(await getElementByText("Log out"));

    expect(requestSpy).toHaveBeenCalledWith("cukii/runVendorAuthAction", {
      vendor: "claude",
      action: "logout",
    });
    expect(
      requestSpy.mock.calls.filter(
        ([messageType]) => messageType === "cukii/listVendorAccounts",
      ),
    ).toHaveLength(1);
    expect(
      await getElementByText(
        "Authentication flow opened in the integrated terminal.",
      ),
    ).toBeDefined();
  });

  it("never paints a stale refresh response after a newer refresh intent", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const ideMessenger = new MockIdeMessenger();
    const originalRequest = ideMessenger.request.bind(ideMessenger);
    let accountRequests = 0;
    vi.spyOn(ideMessenger, "request").mockImplementation((async (
      messageType,
      data,
    ) => {
      if (messageType === "cukii/listVendorAccounts") {
        accountRequests += 1;
        const response = accountRequests === 1 ? first.promise : second.promise;
        return (await response) as never;
      }
      return originalRequest(messageType, data);
    }) as typeof ideMessenger.request);
    const { user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
      { mockIdeMessenger: ideMessenger },
    );
    await waitFor(() => expect(accountRequests).toBe(1));

    const refresh = document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh vendor accounts"]',
    );
    expect(refresh).toBeTruthy();
    await user.click(refresh!);

    await act(async () => {
      first.resolve({
        status: "error",
        error: "stale refresh error",
        done: true,
      });
    });
    await waitFor(() => expect(accountRequests).toBe(2));
    expect(document.body.textContent).not.toContain("stale refresh error");

    const latest = [connectedAccount("newest@example.test")];
    await act(async () => {
      second.resolve({ status: "success", content: latest, done: true });
    });
    await getElementByText("newest@example.test");
    expect(document.body.textContent).not.toContain("stale refresh error");
  });

  it("rejects stale success content symmetrically with stale errors", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const ideMessenger = new MockIdeMessenger();
    const originalRequest = ideMessenger.request.bind(ideMessenger);
    let accountRequests = 0;
    vi.spyOn(ideMessenger, "request").mockImplementation((async (
      messageType,
      data,
    ) => {
      if (messageType === "cukii/listVendorAccounts") {
        accountRequests += 1;
        const response = accountRequests === 1 ? first.promise : second.promise;
        return (await response) as never;
      }
      return originalRequest(messageType, data);
    }) as typeof ideMessenger.request);
    const { user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
      { mockIdeMessenger: ideMessenger },
    );
    await waitFor(() => expect(accountRequests).toBe(1));
    const refresh = document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh vendor accounts"]',
    );
    await user.click(refresh!);

    await act(async () => {
      first.resolve({
        status: "success",
        content: [connectedAccount("stale@example.test")],
        done: true,
      });
    });
    await waitFor(() => expect(accountRequests).toBe(2));
    expect(document.body.textContent).not.toContain("stale@example.test");

    await act(async () => {
      second.resolve({
        status: "error",
        error: "newest refresh error",
        done: true,
      });
    });
    await getElementByText("newest refresh error");
    expect(document.body.textContent).not.toContain("stale@example.test");
  });

  it("invalidates a current snapshot before opening a terminal auth action", async () => {
    const staleList = deferred<unknown>();
    const action = deferred<unknown>();
    const refreshedList = deferred<unknown>();
    const ideMessenger = new MockIdeMessenger();
    const originalRequest = ideMessenger.request.bind(ideMessenger);
    let accountRequests = 0;
    vi.spyOn(ideMessenger, "request").mockImplementation((async (
      messageType,
      data,
    ) => {
      if (messageType === "cukii/listVendorAccounts") {
        accountRequests += 1;
        if (accountRequests === 1) return originalRequest(messageType, data);
        return (await (accountRequests === 2
          ? staleList.promise
          : refreshedList.promise)) as never;
      }
      if (messageType === "cukii/runVendorAuthAction") {
        return (await action.promise) as never;
      }
      return originalRequest(messageType, data);
    }) as typeof ideMessenger.request);
    const { user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
      { mockIdeMessenger: ideMessenger },
    );
    await getElementByText("Log out");
    const refresh = document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh vendor accounts"]',
    );
    expect(refresh).toBeTruthy();
    await user.click(refresh!);
    await waitFor(() => expect(accountRequests).toBe(2));

    const logout = await getElementByText("Log out");
    await user.click(logout);
    await act(async () => {
      staleList.resolve({
        status: "success",
        content: [connectedAccount("stale@example.test")],
        done: true,
      });
    });
    expect(document.body.textContent).not.toContain("stale@example.test");

    await act(async () => {
      action.resolve({
        status: "success",
        content: {
          opened: true,
          message: "Authentication flow opened in the integrated terminal.",
        },
        done: true,
      });
    });
    await waitFor(() => expect(accountRequests).toBe(3));
    await act(async () => {
      refreshedList.resolve({
        status: "success",
        content: [connectedAccount("fresh@example.test")],
        done: true,
      });
    });
    await getElementByText("fresh@example.test");
    expect(document.body.textContent).not.toContain("stale@example.test");
  });

  it("blocks a manual refresh while opening terminal auth, then refreshes after it completes", async () => {
    const action = deferred<unknown>();
    const refreshedList = deferred<unknown>();
    const ideMessenger = new MockIdeMessenger();
    const originalRequest = ideMessenger.request.bind(ideMessenger);
    let accountRequests = 0;
    vi.spyOn(ideMessenger, "request").mockImplementation((async (
      messageType,
      data,
    ) => {
      if (messageType === "cukii/listVendorAccounts") {
        accountRequests += 1;
        if (accountRequests === 1) return originalRequest(messageType, data);
        return (await refreshedList.promise) as never;
      }
      if (messageType === "cukii/runVendorAuthAction") {
        return (await action.promise) as never;
      }
      return originalRequest(messageType, data);
    }) as typeof ideMessenger.request);
    const { user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
      { mockIdeMessenger: ideMessenger },
    );
    await getElementByText("Log out");
    await user.click(await getElementByText("Log out"));

    const refresh = document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh vendor accounts"]',
    );
    expect(refresh).toBeDisabled();
    await user.click(refresh!);
    expect(accountRequests).toBe(1);

    await act(async () => {
      action.resolve({
        status: "success",
        content: {
          opened: true,
          message: "Authentication flow opened in the integrated terminal.",
        },
        done: true,
      });
    });
    await waitFor(() => expect(accountRequests).toBe(2));
    await act(async () => {
      refreshedList.resolve({
        status: "success",
        content: [connectedAccount("fresh-after-action@example.test")],
        done: true,
      });
    });
    await getElementByText("fresh-after-action@example.test");
  });

  it("uses the exact sign-in and unavailable copy", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      {
        id: "codex",
        label: "OpenAI",
        installed: true,
        authenticated: false,
        state: "disconnected",
        accountLabel: "Not logged in",
        actions: ["login"],
      },
      {
        id: "cursor",
        label: "Cursor",
        installed: false,
        authenticated: false,
        state: "unavailable",
        accountLabel: "Not installed",
        actions: ["install"],
      },
    ];
    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });
    await getElementByText("Log in");
    await getElementByText("Not logged in");
    await getElementByText("Not installed");
  });

  it("coalesces timer ticks without starving a slow current probe", async () => {
    vi.useFakeTimers();
    let unmount: (() => void) | undefined;
    try {
      const first = deferred<unknown>();
      const second = deferred<unknown>();
      const ideMessenger = new MockIdeMessenger();
      const originalRequest = ideMessenger.request.bind(ideMessenger);
      let accountRequests = 0;
      vi.spyOn(ideMessenger, "request").mockImplementation((async (
        messageType,
        data,
      ) => {
        if (messageType === "cukii/listVendorAccounts") {
          accountRequests += 1;
          const response =
            accountRequests === 1 ? first.promise : second.promise;
          return (await response) as never;
        }
        return originalRequest(messageType, data);
      }) as typeof ideMessenger.request);
      ({ unmount } = await renderWithProviders(
        <VendorAccountsModal onClose={vi.fn()} />,
        { mockIdeMessenger: ideMessenger },
      ));
      expect(accountRequests).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(accountRequests).toBe(1);

      await act(async () => {
        first.resolve({
          status: "success",
          content: [connectedAccount("current@example.test")],
          done: true,
        });
        await Promise.resolve();
      });
      expect(accountRequests).toBe(2);
      expect(document.body.textContent).toContain("current@example.test");
      expect(document.body.textContent).not.toContain("Checking vendor CLIs");

      await act(async () => {
        second.resolve({
          status: "success",
          content: [connectedAccount("coalesced@example.test")],
          done: true,
        });
        await Promise.resolve();
      });
      expect(accountRequests).toBe(2);
      expect(document.body.textContent).toContain("coalesced@example.test");
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it("clears refresh errors without clearing auth action feedback", async () => {
    const ideMessenger = new MockIdeMessenger();
    const originalRequest = ideMessenger.request.bind(ideMessenger);
    const success = {
      status: "success",
      content: [connectedAccount("owner@example.test")],
      done: true,
    } as const;
    const listResponses: unknown[] = [
      success,
      success,
      { status: "error", error: "refresh failed", done: true },
      success,
    ];
    vi.spyOn(ideMessenger, "request").mockImplementation((async (
      messageType,
      data,
    ) => {
      if (messageType === "cukii/listVendorAccounts") {
        return listResponses.shift() as never;
      }
      return originalRequest(messageType, data);
    }) as typeof ideMessenger.request);
    const { user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
      { mockIdeMessenger: ideMessenger },
    );
    await getElementByText("owner@example.test");
    await user.click(await getElementByText("Log out"));
    const actionFeedback =
      "Authentication flow opened in the integrated terminal.";
    await getElementByText(actionFeedback);
    const refresh = document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh vendor accounts"]',
    );

    await user.click(refresh!);
    await getElementByText("refresh failed");
    expect(document.body.textContent).toContain(actionFeedback);

    await user.click(refresh!);
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("refresh failed"),
    );
    expect(document.body.textContent).toContain(actionFeedback);
  });
});
