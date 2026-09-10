import { createAsyncThunk } from "@reduxjs/toolkit";
import { v4 as uuidv4 } from "uuid";
import {
  abortStream,
  cancelQueuedSteers,
  clearDanglingMessages,
  setCancelling,
  setCancellingSource,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

type CancelStreamArgs = {
  /** "steer" interrupts an in-flight turn to redeliver a live follow-up the
   * vendor could not inject. Like error/lifecycle it must keep the durable
   * outbox alive and drain it; only "user" is a terminal Stop. */
  source?: "user" | "error" | "lifecycle" | "steer";
};

export const cancelStream = createAsyncThunk<
  void,
  CancelStreamArgs | undefined,
  ThunkApiType
>("chat/cancelStream", async (args, { dispatch, extra, getState }) => {
  const session = getState().session;
  const runId = session.activeBridgeRunId;
  const submissionEpoch = session.submissionEpoch;
  const userInitiated = !args?.source || args.source === "user";
  if (session.isCancelling) {
    if (userInitiated && session.cancellingSource !== "user") {
      const latestAssistant = [...session.history]
        .reverse()
        .find((item) => item.message.role === "assistant");
      const interrupted = latestAssistant?.toolCallStates?.some((tool) =>
        ["generated", "generating", "calling"].includes(tool.status),
      )
        ? "tool"
        : "turn";
      // A native cancellation is already in flight, but a later explicit
      // Stop is a new terminal boundary. Rotate the controller and cancel the
      // durable outbox without issuing a duplicate native request.
      dispatch(setInactive());
      dispatch(abortStream());
      dispatch(clearDanglingMessages(interrupted));
      dispatch(cancelQueuedSteers());
    }
    return;
  }
  if (!session.isStreaming) {
    dispatch(setInactive());
    dispatch(abortStream());
    dispatch(clearDanglingMessages());
    return;
  }
  const latestAssistant = [...session.history]
    .reverse()
    .find((item) => item.message.role === "assistant");
  const interrupted = userInitiated
    ? latestAssistant?.toolCallStates?.some((tool) =>
        ["generated", "generating", "calling"].includes(tool.status),
      )
      ? "tool"
      : "turn"
    : undefined;

  // Paint the cancellation immediately. Native process-tree shutdown may
  // take seconds, but it must never keep the composer locked or the loader
  // spinning after the user pressed Stop/Escape.
  dispatch(setInactive());
  dispatch(abortStream());
  dispatch(clearDanglingMessages(interrupted));
  if (userInitiated) {
    // An explicit Stop/Escape is a terminal decision. Cancel the durable
    // follow-up outbox too; otherwise the trailing drain below would restart
    // the bridge a couple of seconds after the user believes it was stopped.
    dispatch(cancelQueuedSteers());
  }
  // Keep duplicate Stop/Escape events gated until the native process-tree
  // cancellation receipt arrives, even though the visible turn is already
  // settled optimistically.
  dispatch(setCancelling(true));
  dispatch(setCancellingSource(userInitiated ? "user" : "internal"));

  const requestId = uuidv4();
  try {
    const response = await extra.ideMessenger.request("cukii/cancelBridgeRun", {
      requestId,
      sessionId: session.id,
      runId,
    });
    const current = getState().session;
    if (
      userInitiated &&
      response.status === "success" &&
      current.id === session.id &&
      current.submissionEpoch === submissionEpoch &&
      !current.isStreaming &&
      current.activeBridgeRunId === undefined &&
      (!runId || !response.content.runId || response.content.runId === runId)
    ) {
      dispatch(clearDanglingMessages(response.content.interrupted));
    }
  } finally {
    const current = getState().session;
    if (
      current.id === session.id &&
      current.submissionEpoch === submissionEpoch &&
      (current.activeBridgeRunId === undefined ||
        current.activeBridgeRunId === runId)
    ) {
      dispatch(setCancelling(false));
      // Only provider/lifecycle cancellations may drain the durable outbox.
      // After an explicit user Stop the queued follow-ups are already
      // cancelled and the broker must stay stopped.
      if (!userInitiated) {
        const { continueIfTrailingSteer } = await import(
          "./continueIfTrailingSteer"
        );
        void dispatch(continueIfTrailingSteer());
      }
    }
  }
});
