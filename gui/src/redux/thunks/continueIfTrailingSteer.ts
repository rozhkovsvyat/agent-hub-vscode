import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { stripImages } from "core/util/messageContent";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { saveCurrentSession } from "./session";
import { streamBrokerBridgeInput } from "./streamBrokerBridgeInput";

const MAX_QUEUED_FOLLOW_UP_TURNS = 8;
const drainingSessions = new Set<string>();

function hasSupportedPayload(item: ChatHistoryItemWithMessageId): boolean {
  // Stateless bridge transcripts currently replace images with a placeholder.
  // Keep image-only follow-ups pending until the route carries image bytes.
  return stripImages(item.message.content).trim().length > 0;
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
      hasSupportedPayload(item),
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

      // Persist the still-pending outbox before launch. Do not claim delivery:
      // a crash between save and vendor activity must remain replayable.
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
          unwrapResult(
            await dispatch(
              saveCurrentSession({
                openNewSession: false,
                generateTitle: false,
              }),
            ),
          );
          return;
        }
      } catch {
        // No positive vendor activity: keep the durable item pending for a
        // later reload/reconnect, but never spin in this live drain.
        if (getState().session.id === sessionId) {
          unwrapResult(
            await dispatch(
              saveCurrentSession({
                openNewSession: false,
                generateTitle: false,
              }),
            ),
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
      const delivered = getState().session.history.find(
        (item) => item.message.id === messageId,
      );
      if (
        delivered?.steerStatus === "queued" ||
        delivered?.steerStatus === "deferred"
      ) {
        // A clean terminal without positive acceptance is not delivery.
        return;
      }
    }
  } finally {
    drainingSessions.delete(sessionId);
  }
});
