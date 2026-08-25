import { createAsyncThunk } from "@reduxjs/toolkit";
import { clearQueuedMessage } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

export const flushQueuedMessage = createAsyncThunk<void, void, ThunkApiType>(
  "chat/flushQueuedMessage",
  async (_, { dispatch, getState }) => {
    const session = getState().session;
    const queued = session.queuedMessage;
    if (!queued || session.isStreaming || session.isInEdit) {
      return;
    }

    dispatch(clearQueuedMessage());
    // Dynamic import avoids streamThunkWrapper → this file → streamResponse → wrapper.
    const { streamResponseThunk } = await import("./streamResponse");
    await dispatch(
      streamResponseThunk({
        editorState: queued.editorState,
        modifiers: queued.modifiers,
      }),
    );
  },
);
