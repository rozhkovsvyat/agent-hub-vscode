import { createAsyncThunk } from "@reduxjs/toolkit";
import { v4 as uuidv4 } from "uuid";
import {
  abortStream,
  clearDanglingMessages,
  setCancelling,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

export const cancelStream = createAsyncThunk<void, undefined, ThunkApiType>(
  "chat/cancelStream",
  async (_, { dispatch, extra, getState }) => {
    const session = getState().session;
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
    const interrupted = latestAssistant?.toolCallStates?.some((tool) =>
      ["generated", "generating", "calling"].includes(tool.status),
    )
      ? "tool"
      : "turn";

    // Paint the cancellation immediately. Native process-tree shutdown may
    // take seconds, but it must never keep the composer locked or the loader
    // spinning after the user pressed Stop/Escape.
    dispatch(setInactive());
    dispatch(abortStream());
    dispatch(clearDanglingMessages(interrupted));
    // Keep duplicate Stop/Escape events gated until the native process-tree
    // cancellation receipt arrives, even though the visible turn is already
    // settled optimistically.
    dispatch(setCancelling(true));

    const requestId = uuidv4();
    try {
      const response = await extra.ideMessenger.request(
        "cukii/cancelBridgeRun",
        { requestId, sessionId: session.id },
      );
      if (response.status === "success") {
        dispatch(clearDanglingMessages(response.content.interrupted));
      }
    } finally {
      dispatch(setCancelling(false));
      if (getState().session.id === session.id) {
        const { continueIfTrailingSteer } =
          await import("./continueIfTrailingSteer");
        void dispatch(continueIfTrailingSteer());
      }
    }
  },
);
