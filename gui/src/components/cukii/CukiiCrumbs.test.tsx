import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { CukiiCrumbs } from "./CukiiCrumbs";

describe("CukiiCrumbs", () => {
  it("uses the title SVG cookie-hole geometry and one exact fill", () => {
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
      { cx: "26.6", cy: "28.8", r: "3.75" },
      { cx: "39.9", cy: "35", r: "5.25" },
      { cx: "28.2", cy: "40.6", r: "4.1" },
    ]);
    expect(
      [...mark.querySelectorAll("[data-cukii-crumb]")].map((crumb) =>
        crumb.getAttribute("fill"),
      ),
    ).toEqual(["#E3A867", "#E3A867", "#E3A867"]);
    expect(
      [...mark.querySelectorAll<SVGCircleElement>("[data-cukii-crumb]")].map(
        (crumb) => crumb.style.animationDelay,
      ),
    ).toEqual(["0ms", "-420ms", "-840ms"]);
  });

  it("uses independent triangular trajectories and a truly static reduced-motion fallback", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    const component = readFileSync(
      join(process.cwd(), "src", "components", "cukii", "CukiiCrumbs.tsx"),
      "utf8",
    );
    expect(component).not.toContain("<g");
    expect(css).toContain("animation: cukiiCrumbVertex");
    expect(css).toContain("33%");
    expect(css).toContain("67%");
    expect(css).not.toContain("cukiiCrumbsOrbit");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".cukii-crumbs-active circle");
    expect(css).toContain("animation: none;");
  });
});
