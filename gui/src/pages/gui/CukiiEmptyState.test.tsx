import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CukiiEmptyState } from "./CukiiEmptyState";

describe("CukiiEmptyState", () => {
  it("renders a Cukii welcome, not Continue branding", () => {
    render(<CukiiEmptyState />);
    const root = screen.getByTestId("cukii-empty-state");
    expect(root).toHaveTextContent("Cukii");
    expect(root).toHaveTextContent("Broker");
    expect(root).not.toHaveTextContent("Continue");
    expect(screen.getByRole("img", { name: "Cukii" })).toBeTruthy();
  });
});
