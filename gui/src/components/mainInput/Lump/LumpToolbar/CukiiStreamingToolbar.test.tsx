import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CukiiStreamingToolbar } from "./CukiiStreamingToolbar";

afterEach(() => vi.useRealTimers());

describe("CukiiStreamingToolbar", () => {
  it("shows the thinking loader without a stop-binding hint", () => {
    render(<CukiiStreamingToolbar />);

    const toolbar = screen.getByTestId("cukii-streaming-toolbar");
    expect(screen.getByTestId("cukii-crumbs")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(toolbar.textContent).toMatch(
      /(?:Crumbing|Combulating|Cookie|Sifting|Baking|Tasting).*\.\.(?!\.)/,
    );
    expect(toolbar.textContent).not.toMatch(/\.\.\./);
    expect(toolbar.textContent).not.toMatch(/Backspace/i);
    expect(toolbar.textContent).not.toMatch(/to stop/i);
    expect(toolbar.textContent).not.toMatch(/\bStop\b/);
    expect(toolbar.querySelectorAll(".cukii-thinking-character")).not.toHaveLength(0);
    expect(toolbar.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(toolbar.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Crumbing through it..",
    );
  });

  it("changes phrases deterministically after its hold while keeping one final announcement", () => {
    vi.useFakeTimers();
    render(<CukiiStreamingToolbar />);
    act(() => vi.advanceTimersByTime(4_000));
    expect(screen.getByText("Combulating..", { selector: '[aria-live="polite"]' })).toBeTruthy();
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });
});
