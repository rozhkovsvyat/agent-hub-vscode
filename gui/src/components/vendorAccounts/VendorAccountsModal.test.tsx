import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { getElementByText } from "../../util/test/utils";
import { VendorAccountsModal } from "./VendorAccountsModal";

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
    ).toHaveLength(2);
    expect(
      await getElementByText(
        "Authentication flow opened in the integrated terminal.",
      ),
    ).toBeDefined();
  });
});
