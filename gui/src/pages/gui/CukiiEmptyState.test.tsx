import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CukiiEmptyState } from "./CukiiEmptyState";

describe("CukiiEmptyState", () => {
  it("renders a Cukii welcome, not Continue branding", () => {
    render(<CukiiEmptyState />);
    const root = screen.getByTestId("cukii-empty-state");
    expect(root).toHaveTextContent("Cukii");
    expect(root).toHaveTextContent("Ready to code?");
    expect(root).toHaveTextContent("Let's write something worth deploying.");
    expect(root.className).toContain("justify-center");
    expect(root.querySelector(".cukii-mark")).toHaveStyle({
      width: "46px",
      height: "46px",
    });
    expect(root).not.toHaveTextContent("Chat, Plan, Agent");
    expect(root).not.toHaveTextContent("Continue");
    expect(screen.getByRole("img", { name: "Cukii" })).toBeTruthy();
  });
});
