type ReceiptStatus = "delivered" | "read" | "deferred";

interface CukiiMessageReceiptStatusProps {
  status: ReceiptStatus;
}

/**
 * Compact messenger-style delivery state. The read state intentionally draws
 * two overlapping paths instead of rendering the two glyphs "✓✓": glyph
 * spacing varies between VS Code fonts and does not read as a double-check.
 */
export function CukiiMessageReceiptStatus({
  status,
}: CukiiMessageReceiptStatusProps) {
  if (status === "deferred") {
    return (
      <span
        aria-hidden="true"
        className="cukii-receipt-status cukii-receipt-status--deferred"
        data-testid="cukii-message-receipt-status-deferred"
      >
        ↷
      </span>
    );
  }

  const isRead = status === "read";
  return (
    <svg
      aria-hidden="true"
      className={
        isRead
          ? "cukii-receipt-status cukii-receipt-check cukii-receipt-check--read"
          : "cukii-receipt-status cukii-receipt-check"
      }
      data-testid={`cukii-message-receipt-status-${status}`}
      fill="none"
      height="10"
      viewBox={isRead ? "0 0 16 10" : "0 0 10 10"}
      width={isRead ? "16" : "10"}
    >
      {isRead && (
        <path
          className="cukii-receipt-check-back"
          d="M1 5L4 8L10 2"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      )}
      <path
        className="cukii-receipt-check-front"
        d={isRead ? "M5 5L8 8L14 2" : "M1 5L4 8L9 2"}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
