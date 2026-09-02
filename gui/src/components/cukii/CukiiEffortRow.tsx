import type {
  BrokerEffort,
  BrokerModel,
} from "../../redux/slices/sessionSlice";
import {
  EFFORT_LABELS,
  effortLevelsForModel,
  normalizeEffortForModel,
} from "../modelSelection/vendors";

interface CukiiEffortRowProps {
  model: BrokerModel;
  effort: BrokerEffort;
  onEffortChange: (next: BrokerEffort) => void;
  className?: string;
}

/** Claude-parity effort row: label on the left, shared slider on the right.
 * Rendered inside the "/" command menu and at the bottom of the model picker,
 * exactly where the reference client keeps its own effort control. */
export function CukiiEffortRow({
  model,
  effort,
  onEffortChange,
  className = "cukii-menu-item",
}: CukiiEffortRowProps) {
  const effortLevels = effortLevelsForModel(model);
  const visibleEffort = normalizeEffortForModel(model, effort);
  const effortIndex = effortLevels.indexOf(visibleEffort);
  const effortFraction = effortIndex / (effortLevels.length - 1);
  const effortPosition = `calc(${effortFraction * 100}% ${9 - effortFraction * 18 >= 0 ? "+" : "-"} ${Math.abs(9 - effortFraction * 18)}px)`;
  const effortFillWidth = `calc(${effortFraction * 100}% + ${18 - effortFraction * 18}px)`;

  const updateFromClientX = (clientX: number, rect: DOMRect) => {
    const trackStart = rect.left + 9;
    const trackWidth = Math.max(1, rect.width - 18);
    const fraction = Math.max(
      0,
      Math.min(1, (clientX - trackStart) / trackWidth),
    );
    const nextIndex = Math.round(fraction * (effortLevels.length - 1));
    onEffortChange(effortLevels[nextIndex]);
  };

  return (
    <div className={className} title="Set how hard the model tries">
      <span>
        Effort
        <span className="ml-1 text-[var(--vscode-descriptionForeground)]">
          ({EFFORT_LABELS[visibleEffort]})
        </span>
      </span>
      <button
        data-testid="cukii-effort-slider"
        type="button"
        className="cukii-effort-slider"
        title="Click or drag to set effort level"
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={effortLevels.length - 1}
        aria-valuenow={effortIndex}
        aria-valuetext={EFFORT_LABELS[visibleEffort]}
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
                ? effortLevels.length - 1
                : Math.max(
                    0,
                    Math.min(
                      effortLevels.length - 1,
                      effortIndex + (event.key === "ArrowRight" ? 1 : -1),
                    ),
                  );
          onEffortChange(effortLevels[nextIndex]);
        }}
      >
        <span className="cukii-effort-fill" style={{ width: effortFillWidth }} />
        {effortLevels.map((level, index) => (
          <span
            key={level}
            className={`cukii-effort-notch ${level === "ultra" ? "cukii-effort-notch-ultra" : ""}`}
            style={{
              left: `calc(${(index / (effortLevels.length - 1)) * 100}% ${9 - (index / (effortLevels.length - 1)) * 18 >= 0 ? "+" : "-"} ${Math.abs(9 - (index / (effortLevels.length - 1)) * 18)}px)`,
            }}
          />
        ))}
        <span className="cukii-effort-thumb" style={{ left: effortPosition }} />
      </button>
    </div>
  );
}
