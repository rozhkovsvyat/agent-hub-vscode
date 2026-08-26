import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CukiiStreamingToolbar } from "./CukiiStreamingToolbar";

describe("CukiiStreamingToolbar", () => {
  it("shows the thinking loader without a stop-binding hint", () => {
    render(<CukiiStreamingToolbar />);

    const toolbar = screen.getByTestId("cukii-streaming-toolbar");
    expect(toolbar.textContent).toMatch(
      /(?:Thinking|Combulating|Sussing|Sifting|Warming|Checking).*\.\.(?!\.)/,
    );
    expect(toolbar.textContent).not.toMatch(/\.\.\./);
    expect(toolbar.textContent).not.toMatch(/Backspace/i);
    expect(toolbar.textContent).not.toMatch(/to stop/i);
    expect(toolbar.textContent).not.toMatch(/\bStop\b/);
  });
});
