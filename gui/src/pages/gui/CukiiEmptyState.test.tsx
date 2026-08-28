import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CUKII_EMPTY_STATE_MESSAGES,
  CukiiEmptyState,
  cukiiEmptyStateMessage,
} from "./CukiiEmptyState";

describe("CukiiEmptyState", () => {
  it("renders the logo and message without a separate Cukii text label", () => {
    render(<CukiiEmptyState />);
    const root = screen.getByTestId("cukii-empty-state");
    expect(root).toHaveTextContent(CUKII_EMPTY_STATE_MESSAGES[0]);
    expect(root).not.toHaveTextContent(/^Cukii$/);
    expect(root.className).toContain("justify-center");
    expect(root.querySelector(".cukii-mark")).toHaveStyle({
      width: "46px",
      height: "46px",
    });
    expect(root).not.toHaveTextContent("Chat, Plan, Agent");
    expect(root).not.toHaveTextContent("Continue");
    expect(screen.getByRole("img", { name: "Cukii" })).toBeTruthy();
  });

  it("selects all ten messages deterministically from session ids", () => {
    const firstPass = Array.from({ length: 1_000 }, (_, index) =>
      cukiiEmptyStateMessage(`session-${index}`),
    );
    const secondPass = Array.from({ length: 1_000 }, (_, index) =>
      cukiiEmptyStateMessage(`session-${index}`),
    );
    expect(secondPass).toEqual(firstPass);
    expect(new Set(firstPass)).toEqual(new Set(CUKII_EMPTY_STATE_MESSAGES));
    expect(CUKII_EMPTY_STATE_MESSAGES).toHaveLength(10);
  });
});
