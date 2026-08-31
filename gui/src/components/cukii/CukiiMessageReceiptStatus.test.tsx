import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CukiiMessageReceiptStatus } from "./CukiiMessageReceiptStatus";

describe("CukiiMessageReceiptStatus", () => {
  it("renders one messenger check for a sent message", () => {
    render(<CukiiMessageReceiptStatus status="sent" />);

    const icon = screen.getByTestId("cukii-message-receipt-status-sent");
    expect(icon.tagName).toBe("svg");
    expect(icon.querySelectorAll("path")).toHaveLength(1);
  });

  it("renders read as two overlapping SVG paths, not two text glyphs", () => {
    render(<CukiiMessageReceiptStatus status="read" />);

    const icon = screen.getByTestId("cukii-message-receipt-status-read");
    const checks = icon.querySelectorAll("path");
    expect(icon).toHaveClass("cukii-receipt-check--read");
    expect(checks).toHaveLength(2);
    expect(checks[0]).toHaveClass("cukii-receipt-check-back");
    expect(checks[1]).toHaveClass("cukii-receipt-check-front");
    expect(checks[0]?.getAttribute("d")).not.toBe(checks[1]?.getAttribute("d"));
    expect(icon.textContent).toBe("");
  });
});
