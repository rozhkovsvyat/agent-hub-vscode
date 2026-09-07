import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { hasImageAttachments, stripImages } from "core/util/messageContent";
import {
  setSteerStatus,
  type ChatHistoryItemWithMessageId,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { saveCurrentSession } from "./session";
import { streamBrokerBridgeInput } from "./streamBrokerBridgeInput";

const MAX_QUEUED_FOLLOW_UP_BATCH_TURNS = 8;
const drainingSessions = new Set<string>();

function hasSupportedPayload(item: ChatHistoryItemWithMessageId): boolean {
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
  return queuedSteerMessages(session)[0];
}

/** One stable snapshot: every deliverable bubble goes into the same turn. */
export function queuedSteerMessages(session: {
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  isInEdit: boolean;
  isCancelling?: boolean;
}): ChatHistoryItemWithMessageId[] {
  if (session.isStreaming || session.isInEdit || session.isCancelling) {
    return [];
  }
  return session.history.filter(
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
>("chat/continueIfTrailingSteer", async (_, { dispatch, getState, extra }) => {
  const sessionId = getState().session.id;
  if (drainingSessions.has(sessionId)) return;
  drainingSessions.add(sessionId);

  try {
    for (let i = 0; i < MAX_QUEUED_FOLLOW_UP_BATCH_TURNS; i++) {
      const session = getState().session;
      if (session.id !== sessionId) return;
      const batch = queuedSteerMessages(session);
      if (batch.length === 0) return;
      const pendingMessageIds: string[] = [];
      let receiptStateChanged = false;

      for (const followUp of batch) {
        const messageId = followUp.message.id;
        // The vendor may already have claimed a bubble mid-run through
        // broker_inbox. Exclude only that bubble; the rest of the snapshot is
        // still dispatched together. A missing/erroring receipt (old host)
        // conservatively keeps the durable delivery path.
        try {
          const inboxReceipt = await extra.ideMessenger.request(
            "cukii/steerInboxReceipt",
            { sessionId, messageId },
          );
          if (
            inboxReceipt.status === "success" &&
            inboxReceipt.content.status === "read"
          ) {
            dispatch(setSteerStatus({ messageId, status: "read" }));
            receiptStateChanged = true;
            continue;
          }
        } catch {
          // Receipt unavailable: keep the durable delivery path.
        }
        pendingMessageIds.push(messageId);
      }

      // Persist the reconciled snapshot before launch. Do not claim the
      // remaining messages delivered: a crash before vendor activity must
      // leave the entire batch replayable.
      unwrapResult(
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: false,
          }),
        ),
      );
      if (pendingMessageIds.length === 0) {
        if (!receiptStateChanged) return;
        continue;
      }

      try {
        const historyLengthAtDispatch = getState().session.history.length;
        unwrapResult(
          await dispatch(
            streamBrokerBridgeInput({
              queuedFollowUpMessageIds: pendingMessageIds,
            }),
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
      const anyStillPending = getState().session.history.some(
        (item) =>
          pendingMessageIds.includes(item.message.id) &&
          (item.steerStatus === "queued" || item.steerStatus === "deferred"),
      );
      if (anyStillPending) {
        // A clean terminal without positive acceptance is not delivery.
        return;
      }
    }
  } finally {
    drainingSessions.delete(sessionId);
  }
});
