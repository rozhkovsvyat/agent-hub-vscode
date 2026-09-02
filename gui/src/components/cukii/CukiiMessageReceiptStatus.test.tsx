import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CukiiMessageReceiptStatus } from "./CukiiMessageReceiptStatus";

describe("CukiiMessageReceiptStatus", () => {
  it("renders one messenger check for a sent message", () => {
    render(<CukiiMessageReceiptStatus status="sent" />);

    const icon = screen.getByTestId("cukii-message-receipt-status-sent");
    expect(icon.tagName).toBe("svg");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "10");
    expect(icon).toHaveAttribute("viewBox", "0 0 16 10");
    expect(icon.querySelectorAll("path")).toHaveLength(1);
  });

  it("renders read as a full check plus a parallel bare stroke", () => {
    render(<CukiiMessageReceiptStatus status="read" />);

    const icon = screen.getByTestId("cukii-message-receipt-status-read");
    const checks = icon.querySelectorAll("path");
    expect(icon).toHaveClass("cukii-receipt-check--read");
    expect(checks).toHaveLength(2);
    expect(checks[0]).toHaveClass("cukii-receipt-check-back");
    expect(checks[1]).toHaveClass("cukii-receipt-check-front");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "10");
    expect(checks[1]?.getAttribute("d")).toBe("M2 5L5 8L11 2");
    // The second check is only its tail: a stroke parallel to the first
    // check's right arm, never an overlapping full check.
    expect(checks[0]?.getAttribute("d")).toBe("M9 8L15 2");
    expect(icon.textContent).toBe("");
  });
});
