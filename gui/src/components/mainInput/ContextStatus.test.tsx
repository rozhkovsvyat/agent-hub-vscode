import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setContextPercentage } from "../../redux/slices/sessionSlice";
import { renderWithProviders } from "../../util/test/render";
import ContextStatus from "./ContextStatus";

describe("ContextStatus", () => {
  it("renders the bar below 60% instead of hiding it", async () => {
    const { store } = await renderWithProviders(<ContextStatus />);
    await act(async () => {
      store.dispatch(setContextPercentage(0.12));
    });
    const bar = await screen.findByTestId("context-status");
    expect(bar).toHaveAttribute("aria-label", "12% of context filled");
  });

  it("renders a zero-fill bar", async () => {
    await renderWithProviders(<ContextStatus />);
    expect(screen.getByTestId("context-status")).toHaveAttribute(
      "aria-label",
      "0% of context filled",
    );
  });
});
