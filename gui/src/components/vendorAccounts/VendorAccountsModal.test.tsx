import { describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
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
    const logout = (await getElementByText("Log out")) as HTMLButtonElement;
    await user.click(logout);

    expect(requestSpy).toHaveBeenCalledWith("cukii/runVendorAuthAction", {
      vendor: "claude",
      action: "logout",
    });
    await waitFor(() =>
      expect(
        requestSpy.mock.calls.filter(
          ([messageType]) => messageType === "cukii/listVendorAccounts",
        ),
      ).toHaveLength(1),
    );
    expect(
      await getElementByText(
        "Authentication flow opened in the integrated terminal.",
      ),
    ).toBeDefined();
  });

  it("stops the install loader and restores Retry after the terminal command fails", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      {
        id: "grok",
        label: "xAI",
        installed: false,
        authenticated: false,
        state: "unavailable",
        accountLabel: "Not installed",
        actions: ["install"],
      },
    ];
    ideMessenger.responses["cukii/runVendorAuthAction"] = {
      opened: true,
      message:
        "CLI installation failed. Fix the error shown in the terminal, then select Install again.",
    };
    const { user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
      { mockIdeMessenger: ideMessenger },
    );

    const install = (await getElementByText("Install")) as HTMLButtonElement;
    await user.click(install);

    await getElementByText(
      "CLI installation failed. Fix the error shown in the terminal, then select Install again.",
    );
    await waitFor(() => {
      const retry = screen.getByText("Install") as HTMLButtonElement;
      expect(retry).not.toBeDisabled();
      expect(retry).toHaveAttribute("aria-busy", "false");
    });
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
    const logout = (await getElementByText("Log out")) as HTMLButtonElement;
    await user.click(logout);

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
    expect(logout).toHaveAttribute("aria-busy", "true");
    expect(logout).toBeDisabled();
    await act(async () => {
      refreshedList.resolve({
        status: "success",
        content: [connectedAccount("fresh-after-action@example.test")],
        done: true,
      });
    });
    await getElementByText("fresh-after-action@example.test");
    expect(await getElementByText("Log out")).toHaveAttribute(
      "aria-busy",
      "false",
    );
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

  it("NEGATIVE CONTROL: never renders Not logged in beside Log out", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      {
        id: "yougile",
        label: "YouGile",
        group: "testing",
        installed: true,
        authenticated: false,
        state: "unknown",
        actions: ["logout"],
      },
    ];

    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });

    await getElementByText("Account status unavailable");
    await getElementByText("Log out");
    expect(document.body.textContent).not.toContain("Not logged in");
  });

  it.each([
    {
      name: "connected plus Log in",
      status: {
        authenticated: true,
        state: "connected" as const,
        accountLabel: "owner@company.ru",
        actions: ["login" as const],
      },
      absent: "Log in",
    },
    {
      name: "disconnected plus Log out",
      status: {
        authenticated: false,
        state: "disconnected" as const,
        accountLabel: "Not logged in",
        actions: ["logout" as const],
      },
      absent: "Log out",
    },
  ])(
    "NEGATIVE CONTROL: filters $name from an inconsistent host",
    async ({ status, absent }) => {
      const ideMessenger = new MockIdeMessenger();
      ideMessenger.responses["cukii/listVendorAccounts"] = [
        {
          id: "yougile",
          label: "YouGile",
          group: "testing",
          installed: true,
          ...status,
        },
      ];

      await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
        mockIdeMessenger: ideMessenger,
      });

      await getElementByText("YouGile");
      expect(document.body.textContent).not.toContain(absent);
    },
  );

  it("shows Alibaba with shared login copy and no token field", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      {
        id: "qwen",
        label: "Alibaba",
        installed: true,
        authenticated: false,
        state: "disconnected",
        accountLabel: "Not logged in",
        actions: ["login"],
      },
      {
        id: "codex",
        label: "OpenAI",
        installed: true,
        authenticated: true,
        state: "connected",
        accountLabel: "owner@alibaba.example",
        actions: ["logout"],
      },
    ];
    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });
    await getElementByText("Alibaba");
    await getElementByText("Log in");
    await getElementByText("Not logged in");
    await getElementByText("Log out");
    expect(document.body.textContent).not.toMatch(
      /api key|token|sk-|endpoint|settings\.json/i,
    );
    expect(document.querySelector("input")).toBeNull();
  });

  it("omits a synthetic subtitle for an authenticated account without identity", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      {
        id: "kimi",
        label: "MoonshotAI",
        installed: true,
        authenticated: true,
        state: "connected",
        actions: ["logout"],
      } as BrokerVendorAuthStatus,
    ];

    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });

    await getElementByText("MoonshotAI");
    await getElementByText("Log out");
    expect(document.body.textContent).not.toMatch(
      /Connected|identity unavailable|Email unavailable/i,
    );
    expect(document.body.textContent).not.toContain(
      "Account status unavailable",
    );
  });

  it("splits the list into Vendors and Testing and says who is signed in", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      {
        id: "codex",
        label: "OpenAI",
        group: "vendor",
        installed: true,
        authenticated: false,
        state: "disconnected",
        actions: ["login"],
      },
      {
        id: "yougile",
        label: "YouGile",
        group: "testing",
        installed: true,
        authenticated: true,
        state: "connected",
        accountLabel: "owner@company.ru",
        actions: ["logout"],
      },
    ];

    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });

    const vendors = await screen.findByTestId("cukii-account-group-vendor");
    const testing = await screen.findByTestId("cukii-account-group-testing");
    expect(vendors.textContent).toContain("Vendors");
    expect(vendors.textContent).toContain("OpenAI");
    // A CLI that is present but signed out says so; only a missing CLI stays
    // silent, because "not logged in" would be the wrong diagnosis there.
    expect(vendors.textContent).toContain("Not logged in");
    expect(testing.textContent).toContain("Testing");
    expect(testing.textContent).toContain("YouGile");
    expect(testing.textContent).toContain("owner@company.ru");
    expect(testing.textContent).not.toContain("OpenAI");
    // Vendors lead; the non-vendor group follows.
    expect(
      vendors.compareDocumentPosition(testing) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders Cukii Box as Agent Memory with the shared login copy", async () => {
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      {
        id: "memory",
        label: "Cukii Box",
        group: "memory",
        installed: true,
        authenticated: false,
        state: "disconnected",
        actions: ["login"],
      },
    ];

    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });

    const memory = await screen.findByTestId("cukii-account-group-memory");
    expect(memory.textContent).toContain("Agent Memory");
    expect(memory.textContent).toContain("Cukii Box");
    // One vocabulary for the whole dialog, not a second pair of verbs for the
    // same state (owner request, board card 39b4d2fe).
    expect(memory.textContent).toContain("Log in");
    expect(memory.textContent).toContain("Not logged in");
    expect(memory.textContent).not.toContain("Connect");
  });

  it("keeps an ungrouped host in Vendors and hides the empty Testing group", async () => {
    // A host that predates grouping sends no `group` at all.
    const ideMessenger = new MockIdeMessenger();
    ideMessenger.responses["cukii/listVendorAccounts"] = [
      connectedAccount("owner@example.com"),
    ];

    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });

    await getElementByText("OpenAI");
    expect(
      document.querySelector("[data-testid='cukii-account-group-vendor']"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-testid='cukii-account-group-testing']"),
    ).toBeNull();
  });

  it("says it is checking CLIs, without calling them vendor CLIs", async () => {
    const pending = deferred<unknown>();
    const ideMessenger = new MockIdeMessenger();
    const originalRequest = ideMessenger.request.bind(ideMessenger);
    vi.spyOn(ideMessenger, "request").mockImplementation((async (
      messageType: string,
      data: unknown,
    ) => {
      if (messageType === "cukii/listVendorAccounts") return pending.promise;
      return originalRequest(messageType as never, data as never);
    }) as typeof ideMessenger.request);

    await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
      mockIdeMessenger: ideMessenger,
    });

    await getElementByText("Checking CLIs…");
    expect(document.body.textContent).not.toContain("vendor CLIs");
    await act(async () => {
      pending.resolve({ status: "success", content: [] });
    });
  });

  it("does not continue a queued refresh after the modal unmounts", async () => {
    const pending = deferred<unknown>();
    const ideMessenger = new MockIdeMessenger();
    const originalRequest = ideMessenger.request.bind(ideMessenger);
    let accountRequests = 0;
    vi.spyOn(ideMessenger, "request").mockImplementation((async (
      messageType: string,
      data: unknown,
    ) => {
      if (messageType === "cukii/listVendorAccounts") {
        accountRequests += 1;
        return pending.promise;
      }
      return originalRequest(messageType as never, data as never);
    }) as typeof ideMessenger.request);

    const rendered = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
      { mockIdeMessenger: ideMessenger },
    );
    await getElementByText("Checking CLIs…");
    await rendered.user.click(
      document.querySelector<HTMLButtonElement>(
        '[aria-label="Refresh vendor accounts"]',
      )!,
    );

    rendered.unmount();
    await act(async () => {
      pending.resolve({ status: "success", content: [] });
      await Promise.resolve();
    });

    expect(accountRequests).toBe(1);
  });

  it("does not rewrite a loaded snapshot without an explicit refresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const ideMessenger = new MockIdeMessenger();
      const originalRequest = ideMessenger.request.bind(ideMessenger);
      let accountRequests = 0;
      vi.spyOn(ideMessenger, "request").mockImplementation((async (
        messageType,
        data,
      ) => {
        if (messageType === "cukii/listVendorAccounts") {
          accountRequests += 1;
          return {
            status: "success",
            content: [connectedAccount("stable@example.test")],
            done: true,
          } as never;
        }
        return originalRequest(messageType, data);
      }) as typeof ideMessenger.request);
      await renderWithProviders(<VendorAccountsModal onClose={vi.fn()} />, {
        mockIdeMessenger: ideMessenger,
      });
      await getElementByText("stable@example.test");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(accountRequests).toBe(1);
      expect(document.body.textContent).toContain("stable@example.test");
    } finally {
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
