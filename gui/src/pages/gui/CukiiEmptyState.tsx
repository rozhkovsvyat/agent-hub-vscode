import { CukiiMark } from "../../components/cukii/CukiiMark";

/** Welcome shown when the thread is empty. Not Continue onboarding cards. */
export function CukiiEmptyState() {
  return (
    <div
      className="mx-auto flex min-h-0 w-full max-w-md flex-1 items-center justify-center text-center"
      data-testid="cukii-empty-state"
    >
      <div className="flex w-full max-w-[266px] translate-y-[5px] flex-col items-center gap-6">
        <CukiiMark size={46} />
        <div className="text-[13px] leading-[20.8px] text-[var(--vscode-foreground)]">
          <div>Cukii</div>
          <div>
            Ready to code? Let&apos;s write something worth deploying.
          </div>
        </div>
      </div>
    </div>
  );
}
