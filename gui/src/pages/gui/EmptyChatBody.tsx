import { ConversationStarterCards } from "../../components/ConversationStarters";
import { OnboardingCard } from "../../components/OnboardingCard";
import { CukiiEmptyState } from "./CukiiEmptyState";

export interface EmptyChatBodyProps {
  showOnboardingCard?: boolean;
}

export function EmptyChatBody({ showOnboardingCard }: EmptyChatBodyProps) {
  if (showOnboardingCard) {
    return (
      <div className="mx-2 mt-6">
        <OnboardingCard />
      </div>
    );
  }

  return (
    <div className="-mx-[6px] flex min-h-0 flex-1 flex-col">
      <CukiiEmptyState />
      <ConversationStarterCards />
    </div>
  );
}
