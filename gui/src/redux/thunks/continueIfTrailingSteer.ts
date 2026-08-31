import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { hasImageAttachments, stripImages } from "core/util/messageContent";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { setSteerStatus } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { saveCurrentSession } from "./session";
import { streamBrokerBridgeInput } from "./streamBrokerBridgeInput";

const MAX_QUEUED_FOLLOW_UP_TURNS = 8;
const drainingSessions = new Set<string>();

function hasPayload(item: ChatHistoryItemWithMessageId): boolean {
  return (
    stripImages(item.message.content).trim().length > 0 ||
    hasImageAttachments(item.message.content)
  );
}

/** Old assistant output may follow the bubble, so scan the whole timeline. */
export function nextQueuedSteerMessage(session: {
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  isInEdit: boolean;
  isCancelling?: boolean;
}): ChatHistoryItemWithMessageId | undefined {
  if (session.isStreaming || session.isInEdit || session.isCancelling) {
    return undefined;
  }
  return session.history.find(
    (item) =>
      item.isSteer &&
      item.message.role === "user" &&
      (item.steerStatus === "queued" || item.steerStatus === "deferred") &&
      hasPayload(item),
  );
}

/** Kept as a compatibility export for existing callers and tests. */
export function hasTrailingSteerMessage(
  session: Parameters<typeof nextQueuedSteerMessage>[0],
): boolean {
  return Boolean(nextQueuedSteerMessage(session));
}

export const continueIfTrailingSteer = createAsyncThunk<
  void,
  void,
  ThunkApiType
>("chat/continueIfTrailingSteer", async (_, { dispatch, getState }) => {
  const sessionId = getState().session.id;
  if (drainingSessions.has(sessionId)) return;
  drainingSessions.add(sessionId);

  try {
    for (let i = 0; i < MAX_QUEUED_FOLLOW_UP_TURNS; i++) {
      const session = getState().session;
      if (session.id !== sessionId) return;
      const followUp = nextQueuedSteerMessage(session);
      const messageId = followUp?.message.id;
      if (!messageId) return;

      // Claim durably before opening the fresh vendor turn. Duplicate terminal
      // receipts and a concurrent drain can no longer submit the same id.
      dispatch(setSteerStatus({ messageId, status: "delivered" }));
      unwrapResult(
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: false,
          }),
        ),
      );

      try {
        const historyLengthAtDispatch = getState().session.history.length;
        unwrapResult(
          await dispatch(
            streamBrokerBridgeInput({ queuedFollowUpMessageId: messageId }),
          ),
        );
        const terminalErrorArrived = getState()
          .session.history.slice(historyLengthAtDispatch)
          .some(
            (item) =>
              (
                item.message as typeof item.message & {
                  cukiiTerminalError?: true;
                }
              ).cukiiTerminalError === true,
          );
        if (terminalErrorArrived) {
          await dispatch(
            saveCurrentSession({
              openNewSession: false,
              generateTitle: false,
            }),
          );
          return;
        }
      } catch {
        // No terminal success: make the durable outbox retryable on the next
        // idle/reload, but never spin in this drain after a bridge failure.
        if (getState().session.id === sessionId) {
          dispatch(setSteerStatus({ messageId, status: "deferred" }));
          await dispatch(
            saveCurrentSession({
              openNewSession: false,
              generateTitle: false,
            }),
          );
        }
        return;
      }

      if (getState().session.id !== sessionId) return;
      unwrapResult(
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: false,
          }),
        ),
      );
    }
  } finally {
    drainingSessions.delete(sessionId);
  }
});
