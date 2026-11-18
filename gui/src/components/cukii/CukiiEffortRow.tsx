import type {
  BrokerEffort,
  BrokerModel,
} from "../../redux/slices/sessionSlice";
import {
  EFFORT_LABELS,
  effortLevelsForModel,
  normalizeEffortForModel,
} from "../modelSelection/vendors";
import { CukiiLevelSlider } from "./CukiiLevelSlider";

interface CukiiEffortRowProps {
  model: BrokerModel;
  effort: BrokerEffort;
  onEffortChange: (next: BrokerEffort) => void;
  className?: string;
}

/** Claude-parity effort row: label on the left, shared slider on the right.
 * The same component is rendered in the command menu, model picker and Modes
 * popover, so geometry and fill cannot drift between the three entry points. */
export function CukiiEffortRow({
  model,
  effort,
  onEffortChange,
  className = "cukii-menu-item",
}: CukiiEffortRowProps) {
  const effortLevels = effortLevelsForModel(model);
  const visibleEffort = normalizeEffortForModel(model, effort);

  return (
    <div className={className} title="Set how hard the model tries">
      <span>
        Effort
        <span className="ml-1 text-[var(--vscode-descriptionForeground)]">
          ({EFFORT_LABELS[visibleEffort]})
        </span>
      </span>
      <CukiiLevelSlider
        testId="cukii-effort-slider"
        levels={effortLevels}
        value={visibleEffort}
        onChange={onEffortChange}
        valueText={EFFORT_LABELS[visibleEffort]}
        ariaLabel="Effort"
        title="Click or drag to set effort level"
        notchClassName={(level) =>
          level === "ultra" ? "cukii-effort-notch-ultra" : ""
        }
        // The reference client recolours the whole fill at its top stop, which
        // is what actually reads at this size; the 4px notch alone does not.
        fillClassName={
          visibleEffort === "ultra" ? "cukii-effort-fill-ultra" : ""
        }
      />
    </div>
  );
}
