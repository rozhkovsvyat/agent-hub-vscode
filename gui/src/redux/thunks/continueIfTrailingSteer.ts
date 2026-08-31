import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { hasImageAttachments, stripImages } from "core/util/messageContent";
import type { ChatHistoryItemWithMessageId } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { streamThunkWrapper } from "./streamThunkWrapper";

const MAX_TRAILING_STEER_TURNS = 8;

export function hasTrailingSteerMessage(session: {
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  isInEdit: boolean;
}): boolean {
  if (session.isStreaming || session.isInEdit) {
    return false;
  }
  const last = session.history.at(-1);
  if (
    !last?.isSteer ||
    last.message.role !== "user" ||
    last.steerStatus === "delivered" ||
    last.steerStatus === "read" ||
    last.steerStatus === "failed"
  ) {
    return false;
  }
  return (
    stripImages(last.message.content).trim().length > 0 ||
    hasImageAttachments(last.message.content)
  );
}

export const continueIfTrailingSteer = createAsyncThunk<
  void,
  void,
  ThunkApiType
>("chat/continueIfTrailingSteer", async (_, { dispatch, getState }) => {
  for (let i = 0; i < MAX_TRAILING_STEER_TURNS; i++) {
    const session = getState().session;
    if (!hasTrailingSteerMessage(session)) {
      return;
    }
    const lastId = session.history.at(-1)?.message.id;
    unwrapResult(
      await dispatch(
        streamThunkWrapper(async () => {
          const { streamNormalInput } = await import("./streamNormalInput");
          unwrapResult(await dispatch(streamNormalInput({})));
        }),
      ),
    );
    if (getState().session.history.at(-1)?.message.id === lastId) {
      return;
    }
  }
});
