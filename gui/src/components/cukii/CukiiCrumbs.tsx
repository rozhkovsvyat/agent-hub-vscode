/** Compact loading mark: three Cukii cookie chips in a calm orbit. */
export function CukiiCrumbs({ active = true }: { active?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`cukii-crumbs ${active ? "cukii-crumbs-active" : ""}`}
      data-testid="cukii-crumbs"
      viewBox="0 0 16 16"
    >
      <g className="cukii-crumbs-orbit">
        <circle data-cukii-crumb="large" cx="5" cy="9.5" r="3.1" />
        <circle data-cukii-crumb="medium" cx="10.5" cy="5" r="2.25" />
        <circle data-cukii-crumb="small" cx="12" cy="11.5" r="1.45" />
      </g>
    </svg>
  );
}
