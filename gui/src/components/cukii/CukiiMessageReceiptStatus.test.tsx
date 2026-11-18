import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CukiiMessageReceiptStatus } from "./CukiiMessageReceiptStatus";

describe("CukiiMessageReceiptStatus", () => {
  it("renders one messenger check for a sent message", () => {
    render(<CukiiMessageReceiptStatus status="sent" />);

    const icon = screen.getByTestId("cukii-message-receipt-status-sent");
    expect(icon.tagName).toBe("svg");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(icon.querySelectorAll("path")).toHaveLength(1);
    expect(icon.querySelector("path")).toHaveAttribute(
      "d",
      "M18.09 5.589a.9.9 0 0 1 0 1.272L7.063 17.886a.9.9 0 0 1-1.273 0L1.884 13.98a.9.9 0 0 1 1.273-1.273l3.27 3.271L16.818 5.59a.9.9 0 0 1 1.272 0",
    );
  });

  it("renders read as a full check plus a parallel bare stroke", () => {
    render(<CukiiMessageReceiptStatus status="read" />);

    const icon = screen.getByTestId("cukii-message-receipt-status-read");
    const checks = icon.querySelectorAll("path");
    expect(icon).toHaveClass("cukii-receipt-check--read");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toHaveClass("cukii-receipt-check-read");
    expect(icon).toHaveAttribute("width", "16");
    expect(icon).toHaveAttribute("height", "16");
    expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
    expect(checks[0]).toHaveAttribute("fill-rule", "evenodd");
    expect(checks[0]).toHaveAttribute("clip-rule", "evenodd");
    expect(checks[0]?.getAttribute("d")).toBe(
      "M18.089 5.589a.9.9 0 0 1 0 1.272L7.064 17.886a.9.9 0 0 1-1.273 0L1.883 13.98a.9.9 0 0 1 1.273-1.273l3.271 3.271L16.816 5.59a.9.9 0 0 1 1.273 0m5.459-.001a.9.9 0 0 1 0 1.273L12.523 17.887a.9.9 0 0 1-1.272 0l-.73-.73a.9.9 0 0 1 1.273-1.272l.093.092L22.276 5.59a.9.9 0 0 1 1.272 0",
    );
    expect(icon.textContent).toBe("");
  });
});
