import type { ModelInfo } from "./vendors";
import { cukiiCapabilityRating } from "./vendors";

function MilkMark() {
  return (
    <svg
      aria-hidden="true"
      className="cukii-capability-milk"
      data-cukii-capability-milk="true"
      viewBox="0 0 16 16"
    >
      <path
        d="M6 1h4v2H6V1Zm-.5 3h5v1.25L12 7v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7l1.5-1.75V4Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function ModelCapabilityRating({ model }: { model: ModelInfo }) {
  const rating = cukiiCapabilityRating(model);
  const accessibleLabel = `Cukii capability rating: ${rating} of 4`;

  return (
    <span
      aria-label={accessibleLabel}
      className="cukii-capability-rating"
      data-testid={`cukii-capability-rating-${model.value}`}
      role="img"
      title={accessibleLabel}
    >
      {Array.from({ length: rating }, (_, index) => (
        <MilkMark key={index} />
      ))}
    </span>
  );
}
