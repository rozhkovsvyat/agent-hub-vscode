import type { BrokerAutocompact } from "../../redux/slices/sessionSlice";
import { CukiiLevelSlider } from "./CukiiLevelSlider";

/**
 * Stops in the order the owner asked for: three explicit shares, then
 * "Default" as the right-hand stop meaning "do not force a share".
 */
export const AUTOCOMPACT_LEVELS: readonly BrokerAutocompact[] = [
  "25",
  "50",
  "75",
  "default",
] as const;

export const AUTOCOMPACT_LABELS: Record<BrokerAutocompact, string> = {
  "25": "25%",
  "50": "50%",
  "75": "75%",
  default: "Default",
};

/** The one value the model pill stays silent about. */
export const AUTOCOMPACT_DEFAULT: BrokerAutocompact = "default";

/** Shown in the pill; empty string means "say nothing". */
export function autocompactPillLabel(value: BrokerAutocompact): string {
  return value === AUTOCOMPACT_DEFAULT ? "" : AUTOCOMPACT_LABELS[value];
}

interface CukiiAutocompactRowProps {
  autocompact: BrokerAutocompact;
  onAutocompactChange: (next: BrokerAutocompact) => void;
  className?: string;
}

/**
 * Autocompact row — same control as Effort, four stops, and it sits directly
 * above Effort in the "/" menu and in the model picker footer.
 *
 * This setting used to live in the agent instructions, where each vendor
 * restated the threshold in its own contract and the numbers drifted apart.
 * It belongs to the plugin: one value, one place to change it, visible in the
 * pill so the current threshold is never a guess.
 */
export function CukiiAutocompactRow({
  autocompact,
  onAutocompactChange,
  className = "cukii-menu-item",
}: CukiiAutocompactRowProps) {
  return (
    <div
      className={className}
      title="Share of the context window at which the thread auto-compacts"
    >
      <span>
        Autocompact
        <span className="ml-1 text-[var(--vscode-descriptionForeground)]">
          ({AUTOCOMPACT_LABELS[autocompact]})
        </span>
      </span>
      <CukiiLevelSlider
        testId="cukii-autocompact-slider"
        levels={AUTOCOMPACT_LEVELS}
        value={autocompact}
        onChange={onAutocompactChange}
        valueText={AUTOCOMPACT_LABELS[autocompact]}
        ariaLabel="Autocompact"
        title="Click or drag to set the autocompact threshold"
      />
    </div>
  );
}
