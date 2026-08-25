import { CukiiMark } from "../../components/cukii/CukiiMark";

/** Welcome shown when the thread is empty. Not Continue onboarding cards. */
export function CukiiEmptyState() {
  return (
    <div
      className="mx-auto flex max-w-md flex-col items-center gap-3 px-4 py-8 text-center"
      data-testid="cukii-empty-state"
    >
      <CukiiMark size={48} />
      <div className="text-foreground text-base font-medium">Cukii</div>
      <p className="text-description m-0 text-xs leading-5">
        Chat, Plan, Agent — plus Broker, which can run a nested worker without
        freezing the thread.
      </p>
    </div>
  );
}
