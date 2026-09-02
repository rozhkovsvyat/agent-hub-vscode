type ReceiptStatus = "sent" | "read";

interface CukiiMessageReceiptStatusProps {
  status: ReceiptStatus;
}

/**
 * Compact messenger-style delivery state. The read state draws a full check
 * plus a parallel bare stroke (the second check's tail only), Telegram-style:
 * overlapping full checks read as one thick glyph at 10px height.
 */
export function CukiiMessageReceiptStatus({
  status,
}: CukiiMessageReceiptStatusProps) {
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
      viewBox="0 0 16 10"
      width="16"
    >
      {isRead && (
        <path
          className="cukii-receipt-check-back"
          d="M9 8L15 2"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      )}
      <path
        className="cukii-receipt-check-front"
        d="M2 5L5 8L11 2"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}
