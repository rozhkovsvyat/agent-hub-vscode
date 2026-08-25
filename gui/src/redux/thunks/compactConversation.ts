import { createAsyncThunk } from "@reduxjs/toolkit";
import { setCompactionLoading } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { loadSession } from "./session";

export const compactConversationThunk = createAsyncThunk<
  void,
  { index: number },
  ThunkApiType
>("conversation/compact", async ({ index }, { dispatch, extra, getState }) => {
  const currentSessionId = getState().session.id;
  if (!currentSessionId) {
    return;
  }

  try {
    dispatch(setCompactionLoading({ index, loading: true }));

    await extra.ideMessenger.request("conversation/compact", {
      index,
      sessionId: currentSessionId,
    });

    await dispatch(
      loadSession({
        sessionId: currentSessionId,
        saveCurrentSession: false,
      }),
    );
  } catch (error) {
    console.error("Error compacting conversation:", error);
  } finally {
    dispatch(setCompactionLoading({ index, loading: false }));
  }
});
