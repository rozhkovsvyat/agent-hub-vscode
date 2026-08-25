import { createAsyncThunk } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { stripImages } from "core/util/messageContent";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { appendUserSteerMessage } from "../slices/sessionSlice";
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

    dispatch(
      appendUserSteerMessage({
        content,
        contextItems: selectedContextItems,
        editorState,
      }),
    );
    extra.ideMessenger.post("cukii/steerDuringStream", {
      text: stripImages(content),
    });
  },
);
