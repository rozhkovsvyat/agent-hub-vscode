import { createAsyncThunk } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { stripImages } from "core/util/messageContent";
import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { appendUserSteerMessage, setSteerStatus } from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

export const steerDuringStream = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
  },
  ThunkApiType
>(
  "chat/steerDuringStream",
  async ({ editorState, modifiers }, { dispatch, extra, getState }) => {
    const state = getState();
    if (!state.session.isStreaming || state.session.isInEdit) {
      return;
    }

    const defaultContextProviders =
      state.config.config.experimental?.defaultContext ?? [];
    const { content, selectedContextItems } = await resolveEditorContent({
      editorState,
      modifiers,
      ideMessenger: extra.ideMessenger,
      defaultContextProviders,
      availableSlashCommands: state.config.config.slashCommands,
      dispatch,
      getState,
    });

    const currentSession = getState().session;
    if (!currentSession.isStreaming || currentSession.id !== state.session.id) {
      return;
    }
    const messageId = uuidv4();
    const sessionId = currentSession.id;
    dispatch(
      appendUserSteerMessage({
        messageId,
        content,
        contextItems: selectedContextItems,
        editorState,
      }),
    );
    const response = await extra.ideMessenger.request(
      "cukii/steerDuringStream",
      {
        messageId,
        sessionId,
        text: stripImages(content),
      },
    );
    dispatch(
      setSteerStatus({
        messageId,
        status:
          response.status === "success" ? response.content.status : "failed",
      }),
    );
  },
);
