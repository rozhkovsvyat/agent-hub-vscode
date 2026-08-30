/**
 * Compact loading mark built from the three cookie holes in the Cukii title
 * SVG. Keeping the source geometry here (rather than approximating it in a
 * rotating wrapper) makes the mark read as a tiny piece of the same cookie.
 */
const COOKIE_HOLES = [
  { name: "small", cx: 26.6, cy: 28.8, r: 3.75, phase: "0ms" },
  { name: "large", cx: 39.9, cy: 35, r: 5.25, phase: "-420ms" },
  { name: "medium", cx: 28.2, cy: 40.6, r: 4.1, phase: "-840ms" },
] as const;

export function CukiiCrumbs({ active = true }: { active?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`cukii-crumbs ${active ? "cukii-crumbs-active" : ""}`}
      data-testid="cukii-crumbs"
      viewBox="20 22 28 27"
    >
      {COOKIE_HOLES.map((crumb) => (
        <circle
          key={crumb.name}
          data-cukii-crumb={crumb.name}
          cx={crumb.cx}
          cy={crumb.cy}
          r={crumb.r}
          fill="#E3A867"
          style={{ animationDelay: crumb.phase }}
        />
      ))}
    </svg>
  );
}
