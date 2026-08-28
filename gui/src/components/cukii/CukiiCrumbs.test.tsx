import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { CukiiCrumbs } from "./CukiiCrumbs";

describe("CukiiCrumbs", () => {
  it("renders three differently-sized, presentation-only cookie chips", () => {
    render(<CukiiCrumbs />);
    const mark = screen.getByTestId("cukii-crumbs");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveClass("cukii-crumbs-active");
    expect(
      [...mark.querySelectorAll("[data-cukii-crumb]")].map((crumb) => ({
        cx: crumb.getAttribute("cx"),
        cy: crumb.getAttribute("cy"),
        r: crumb.getAttribute("r"),
      })),
    ).toEqual([
      { cx: "4.4", cy: "9.5", r: "3.1" },
      { cx: "9.9", cy: "5", r: "2.25" },
      { cx: "11.4", cy: "11.5", r: "1.45" },
    ]);
  });

  it("keeps the calm orbit and a reduced-motion fallback in CSS", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    expect(css).toContain("animation: cukiiCrumbsOrbit 1.2s");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: cukiiCrumbRest 1.8s");
  });
});
