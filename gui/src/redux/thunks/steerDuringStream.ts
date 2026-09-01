import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import {
  appendUserSteerMessage,
  requestSteerInterrupt,
  setSteerStatus,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { saveCurrentSession } from "./session";
import { streamResponseThunk } from "./streamResponse";

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
    if (state.session.isInEdit) {
      return;
    }
    if (!state.session.isStreaming) {
      // React's isStreaming ref can lag one render behind Redux when a run
      // stops or hands off. The editor has already been cleared by this point,
      // so route the captured input into a normal turn instead of dropping it.
      await dispatch(streamResponseThunk({ editorState, modifiers }));
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
      if (!currentSession.isStreaming) {
        // The run may finish while context providers resolve. Preserve the
        // captured input via the same normal-turn fallback.
        await dispatch(streamResponseThunk({ editorState, modifiers }));
      }
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
    // This is a durable outbox item, not transient composer state. Save it
    // before asking the live bridge so reload/Remote-SSH reconnect cannot
    // erase a bubble that already carries its sent checkmark.
    unwrapResult(
      await dispatch(
        saveCurrentSession({ openNewSession: false, generateTitle: false }),
      ),
    );
    let deferredByVendor = false;
    try {
      const response = await extra.ideMessenger.request(
        "cukii/steerDuringStream",
        {
          messageId,
          sessionId,
          content,
        },
      );
      const status =
        response.status === "success" ? response.content.status : "failed";
      deferredByVendor = status === "deferred";
      dispatch(setSteerStatus({ messageId, status }));
    } catch {
      // The persisted bubble stays retryable if the live bridge disappeared.
      // Treat transport loss like an explicit deferred receipt: settle any
      // stale GUI run and drain the durable outbox through a fresh turn.
      deferredByVendor = true;
      dispatch(setSteerStatus({ messageId, status: "deferred" }));
    }
    unwrapResult(
      await dispatch(
        saveCurrentSession({ openNewSession: false, generateTitle: false }),
      ),
    );

    // The vendor cannot accept live steering (e.g. Qwen runs a single
    // non-interactive turn with closed stdin). Instead of leaving the bubble
    // queued until the current turn finishes on its own, interrupt the run so
    // the follow-up is redelivered as a fresh turn right away. Claude is not
    // affected: its receipt comes back "delivered", never "deferred".
    if (deferredByVendor) {
      const current = getState().session;
      if (
        current.id === sessionId &&
        current.isStreaming &&
        !current.isCancelling
      ) {
        dispatch(requestSteerInterrupt());
        await dispatch(cancelStream({ source: "steer" }));
      }
    }
  },
);
