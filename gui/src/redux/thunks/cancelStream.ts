import { createAsyncThunk } from "@reduxjs/toolkit";
import { v4 as uuidv4 } from "uuid";
import {
  abortStream,
  cancelQueuedSteers,
  clearDanglingMessages,
  setCancelling,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

type CancelStreamArgs = {
  source?: "user" | "error" | "lifecycle";
};

export const cancelStream = createAsyncThunk<
  void,
  CancelStreamArgs | undefined,
  ThunkApiType
>("chat/cancelStream", async (args, { dispatch, extra, getState }) => {
  const session = getState().session;
  const userInitiated = !args?.source || args.source === "user";
  if (session.isCancelling) return;
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

  const requestId = uuidv4();
  try {
    const response = await extra.ideMessenger.request("cukii/cancelBridgeRun", {
      requestId,
      sessionId: session.id,
    });
    if (
      userInitiated &&
      response.status === "success" &&
      getState().session.id === session.id
    ) {
      dispatch(clearDanglingMessages(response.content.interrupted));
    }
  } finally {
    if (getState().session.id === session.id) {
      dispatch(setCancelling(false));
      // Only provider/lifecycle cancellations may drain the durable outbox.
      // After an explicit user Stop the queued follow-ups are already
      // cancelled and the broker must stay stopped.
      if (!userInitiated) {
        const { continueIfTrailingSteer } =
          await import("./continueIfTrailingSteer");
        void dispatch(continueIfTrailingSteer());
      }
    }
  }
});
