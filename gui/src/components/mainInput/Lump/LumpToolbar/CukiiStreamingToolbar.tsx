export type CukiiWaitReceipt = {
  condition: string;
  deadline?: string;
};

/** Static receipt for an explicit native pause — intentionally no Crumbs. */
export function CukiiWaitingReceipt({ wait }: { wait: CukiiWaitReceipt }) {
  return (
    <div
      aria-live="polite"
      className="cukii-waiting-receipt text-description px-2 py-2 text-xs"
      data-testid="cukii-waiting-receipt"
      role="status"
    >
      <span>Cukii is waiting — {wait.condition}</span>
      {wait.deadline && <span> · until {wait.deadline}</span>}
    </div>
  );
}
