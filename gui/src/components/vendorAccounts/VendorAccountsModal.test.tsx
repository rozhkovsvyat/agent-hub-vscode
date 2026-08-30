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

describe("VendorAccountsModal", () => {
  it("shows native CLI accounts and opens the requested auth flow", async () => {
    const { ideMessenger, user } = await renderWithProviders(
      <VendorAccountsModal onClose={vi.fn()} />,
    );
    const requestSpy = vi.spyOn(ideMessenger, "request");

    await getElementByText("Anthropic");
    await getElementByText("DeepSeek");
    await getElementByText("owner@example.com");
    await getElementByText("Not configured / not yet supported");
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
    vi.spyOn(ideMessenger, "request").mockImplementation(
      (async (messageType, data) => {
        if (messageType === "cukii/listVendorAccounts") {
          accountRequests += 1;
          const response = accountRequests === 1 ? first.promise : second.promise;
          return (await response) as never;
        }
        return originalRequest(messageType, data);
      }) as typeof ideMessenger.request,
    );
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

    const latest: BrokerVendorAuthStatus[] = [
      {
        id: "codex",
        label: "OpenAI",
        installed: true,
        authenticated: true,
        state: "connected",
        accountLabel: "newest@example.test",
        actions: ["logout"],
      },
    ];
    await act(async () => {
      second.resolve({ status: "success", content: latest, done: true });
    });
    await getElementByText("newest@example.test");
    expect(document.body.textContent).not.toContain("stale refresh error");
  });
});
