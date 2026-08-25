import { GeneratingIndicator } from "./GeneratingIndicator";

interface StreamingToolbarProps {
  onStop: () => void;
  displayText?: string;
}

export function StreamingToolbar({
  onStop,
  displayText = "Stop",
}: StreamingToolbarProps) {
  return (
    <div className="flex w-full items-center justify-between">
      <GeneratingIndicator />
      <div
        onClick={onStop}
        className="text-2xs cursor-pointer px-1.5 py-0.5 hover:brightness-125"
      >
        <span className="text-description">{displayText}</span>
        <span className="text-description-muted ml-1 opacity-75">Esc</span>
      </div>
    </div>
  );
}
