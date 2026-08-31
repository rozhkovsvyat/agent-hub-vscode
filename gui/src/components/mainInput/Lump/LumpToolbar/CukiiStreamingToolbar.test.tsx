import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CukiiStreamingToolbar,
  CukiiWaitingReceipt,
  splitThinkingPhrase,
} from "./CukiiStreamingToolbar";

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
    expect(
      toolbar.querySelectorAll(".cukii-thinking-character"),
    ).not.toHaveLength(0);
    expect(toolbar.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(toolbar.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Crumbing through it..",
    );
  });

  it("changes phrases deterministically after its hold while keeping one final announcement", () => {
    vi.useFakeTimers();
    render(<CukiiStreamingToolbar />);
    act(() => vi.advanceTimersByTime(4_000));
    expect(
      screen.getByText("Combulating..", { selector: '[aria-live="polite"]' }),
    ).toBeTruthy();
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
  });

  it("keeps rendered word gaps as non-animated whitespace, not collapsed character spans", () => {
    render(<CukiiStreamingToolbar />);

    const toolbar = screen.getByTestId("cukii-streaming-toolbar");
    const spaces = toolbar.querySelectorAll(
      '[data-testid="cukii-thinking-space"]',
    );
    expect(spaces).toHaveLength(2);
    spaces.forEach((space) => {
      expect(space.textContent).toBe(" ");
      expect(space).not.toHaveClass("cukii-thinking-character");
    });
    expect(toolbar.querySelectorAll(".cukii-thinking-character")).toHaveLength(
      splitThinkingPhrase("Crumbing through it..").length - spaces.length,
    );
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    expect(css).toMatch(/\.cukii-thinking-space\s*\{[^}]*white-space:\s*pre/s);
  });

  it("reserves phrase width and makes character reconstruction instant for reduced motion", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    expect(css).toMatch(/\.cukii-thinking-text\s*\{[^}]*min-width:\s*21ch/s);
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.cukii-thinking-character\s*\{[^}]*animation:\s*none/s,
    );
  });

  it("hides only for an explicit native wait, not unknown stream silence", () => {
    const { rerender } = render(<CukiiStreamingToolbar active />);
    expect(screen.getByTestId("cukii-streaming-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("cukii-crumbs")).toBeInTheDocument();

    rerender(
      <CukiiStreamingToolbar
        active
        wait={{
          condition: "Sleeping for 12 seconds",
          deadline: "2026-08-31T12:00:12.000Z",
        }}
      />,
    );
    expect(
      screen.queryByTestId("cukii-streaming-toolbar"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("cukii-crumbs")).not.toBeInTheDocument();
  });

  it("renders the wait receipt as a static accessible status", () => {
    render(
      <CukiiWaitingReceipt
        wait={{
          condition: "Sleeping for 12 seconds",
          deadline: "2026-08-31T12:00:12.000Z",
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Cukii is waiting — Sleeping for 12 seconds · until 2026-08-31T12:00:12.000Z",
    );
    expect(screen.queryByTestId("cukii-crumbs")).not.toBeInTheDocument();
  });
});
