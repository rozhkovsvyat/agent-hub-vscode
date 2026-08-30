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
    dispatch(setCancelling(true));
    const requestId = uuidv4();
    try {
      const response = await extra.ideMessenger.request(
        "cukii/cancelBridgeRun",
        { requestId, sessionId: session.id },
      );
      if (response.status !== "success") return;
      dispatch(setInactive());
      dispatch(abortStream());
      dispatch(clearDanglingMessages(response.content.interrupted));
    } finally {
      dispatch(setCancelling(false));
    }
  },
);
