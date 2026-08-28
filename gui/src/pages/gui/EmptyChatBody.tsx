import { ConversationStarterCards } from "../../components/ConversationStarters";
import { CukiiEmptyState } from "./CukiiEmptyState";

export function EmptyChatBody({ sessionId }: { sessionId?: string }) {
  return (
    <div className="-mx-[6px] flex min-h-0 flex-1 flex-col">
      <CukiiEmptyState sessionId={sessionId} />
      <ConversationStarterCards />
    </div>
  );
}
