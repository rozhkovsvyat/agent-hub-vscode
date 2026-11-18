interface CukiiLevelSliderProps<T extends string> {
  /** Ordered stops, left to right. */
  levels: readonly T[];
  value: T;
  onChange: (next: T) => void;
  /** Human label for the current stop, announced to screen readers. */
  valueText: string;
  ariaLabel: string;
  testId: string;
  title?: string;
  /** Extra class for one notch — Effort marks its "ultra" stop. */
  notchClassName?: (level: T) => string;
  /** Extra class for the fill — Effort recolours it at "ultra". */
  fillClassName?: string;
}

/**
 * The capsule slider shared by every discrete Cukii setting that has more than
 * two stops (Effort, Autocompact). Extracted so the two rows cannot drift apart
 * visually — they used to be one component copied twice, which is exactly how
 * the Effort control ended up 5px off from the plain toggles next to it.
 *
 * Geometry note: the reference track is 76×18 with a 14px thumb inset 2px, so
 * the thumb's CENTRE travels between 9px and width−9px — a 76−18 = 58px range.
 * Every position below is expressed against that centre travel, not against the
 * raw element width, and `9` here is the centre inset, not half the thumb.
 */
export function CukiiLevelSlider<T extends string>({
  levels,
  value,
  onChange,
  valueText,
  ariaLabel,
  testId,
  title,
  notchClassName,
  fillClassName,
}: CukiiLevelSliderProps<T>) {
  const lastIndex = Math.max(1, levels.length - 1);
  const index = Math.max(0, levels.indexOf(value));
  const fraction = index / lastIndex;

  const offsetFor = (at: number) => {
    const shift = 9 - at * 18;
    return `calc(${at * 100}% ${shift >= 0 ? "+" : "-"} ${Math.abs(shift)}px)`;
  };

  const updateFromClientX = (clientX: number, rect: DOMRect) => {
    const trackStart = rect.left + 9;
    const trackWidth = Math.max(1, rect.width - 18);
    const next = Math.max(0, Math.min(1, (clientX - trackStart) / trackWidth));
    onChange(levels[Math.round(next * lastIndex)]);
  };

  return (
    <button
      data-testid={testId}
      type="button"
      className="cukii-effort-slider"
      title={title}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={lastIndex}
      aria-valuenow={index}
      aria-valuetext={valueText}
      role="slider"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        updateFromClientX(
          event.clientX,
          event.currentTarget.getBoundingClientRect(),
        );
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // jsdom (tests) lacks the pointer-capture API.
        event.currentTarget.setPointerCapture?.(event.pointerId);
        updateFromClientX(
          event.clientX,
          event.currentTarget.getBoundingClientRect(),
        );
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) return;
        event.preventDefault();
        event.stopPropagation();
        updateFromClientX(
          event.clientX,
          event.currentTarget.getBoundingClientRect(),
        );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }
      }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        const nextIndex =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastIndex
              : Math.max(
                  0,
                  Math.min(
                    lastIndex,
                    index + (event.key === "ArrowRight" ? 1 : -1),
                  ),
                );
        onChange(levels[nextIndex]);
      }}
    >
      <span
        className={`cukii-effort-fill ${fillClassName ?? ""}`}
        style={{ width: `calc(${fraction * 100}% + ${18 - fraction * 18}px)` }}
      />
      {levels.map((level, at) => (
        <span
          key={level}
          className={`cukii-effort-notch ${notchClassName?.(level) ?? ""}`}
          style={{ left: offsetFor(at / lastIndex) }}
        />
      ))}
      <span
        className="cukii-effort-thumb"
        style={{ left: offsetFor(fraction) }}
      />
    </button>
  );
}
