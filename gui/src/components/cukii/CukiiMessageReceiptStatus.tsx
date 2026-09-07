type ReceiptStatus = "sent" | "read";

interface CukiiMessageReceiptStatusProps {
  status: ReceiptStatus;
}

const DELIVERED_PATH =
  "M18.09 5.589a.9.9 0 0 1 0 1.272L7.063 17.886a.9.9 0 0 1-1.273 0L1.884 13.98a.9.9 0 0 1 1.273-1.273l3.27 3.271L16.818 5.59a.9.9 0 0 1 1.272 0";

const READ_PATH =
  "M18.089 5.589a.9.9 0 0 1 0 1.272L7.064 17.886a.9.9 0 0 1-1.273 0L1.883 13.98a.9.9 0 0 1 1.273-1.273l3.271 3.271L16.816 5.59a.9.9 0 0 1 1.273 0m5.459-.001a.9.9 0 0 1 0 1.273L12.523 17.887a.9.9 0 0 1-1.272 0l-.73-.73a.9.9 0 0 1 1.273-1.272l.093.092L22.276 5.59a.9.9 0 0 1 1.272 0";

/** Exact web.max.ru status geometry: a 24-unit filled glyph centred in a
 * 16×16 indicator slot beside the 11/14px time label. */
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
      height="16"
      viewBox="0 0 24 24"
      width="16"
    >
      <path
        className={
          isRead ? "cukii-receipt-check-read" : "cukii-receipt-check-delivered"
        }
        clipRule="evenodd"
        d={isRead ? READ_PATH : DELIVERED_PATH}
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
