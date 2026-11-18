import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";
import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import {
  appendUserSteerMessage,
  setSteerStatus,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
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
      // The edit run streams too, but has no live steer channel. The composer
      // is already cleared by now, so route the captured input through the
      // same durable outbox as every other deferred steer; the trailing drain
      // redelivers it once the edit window settles. Dropping it here would
      // lose text that never reaches history or the outbox.
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
      if (
        !currentSession.isStreaming ||
        currentSession.id !== state.session.id
      ) {
        return;
      }
      const messageId = uuidv4();
      dispatch(
        appendUserSteerMessage({
          messageId,
          content,
          contextItems: selectedContextItems,
          editorState,
        }),
      );
      dispatch(setSteerStatus({ messageId, status: "deferred" }));
      unwrapResult(
        await dispatch(
          saveCurrentSession({ openNewSession: false, generateTitle: false }),
        ),
      );
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
    let acceptedLive = false;
    try {
      const response = await extra.ideMessenger.request(
        "cukii/steerDuringStream",
        {
          messageId,
          sessionId,
          content,
          brokerModel: currentSession.brokerModel,
        },
      );
      acceptedLive =
        response.status === "success" &&
        response.content.status === "delivered";
      dispatch(
        setSteerStatus({ messageId, status: acceptedLive ? "delivered" : "queued" }),
      );
    } catch {
      // The persisted bubble stays retryable if the live bridge disappeared.
      // Transport loss is just another "not accepted live": the outbox keeps
      // the message until a turn boundary delivers it.
      dispatch(setSteerStatus({ messageId, status: "queued" }));
    }
    unwrapResult(
      await dispatch(
        saveCurrentSession({ openNewSession: false, generateTitle: false }),
      ),
    );

    // Vendors without a live steer channel (e.g. Qwen runs a single
    // non-interactive turn with closed stdin) get the message through the
    // durable outbox instead of an interrupt: the old stop-and-restart path
    // raced its own teardown, leaked parallel bridge processes, and lost the
    // follow-up receipt while the cold restart had nothing to show. The
    // running turn stays alive; the drain delivers the bubble as the very
    // next turn the moment this one settles, so the agent continues its work
    // and reads the new instruction in context — the same outcome Claude's
    // live injection gives, minus the kill. Claude is unaffected: its
    // receipt arrives "delivered" and nothing is queued. The nudge also
    // covers the race where the run settled while the request was in flight:
    // without it the bubble would wait for a lifecycle event that may never
    // come. The drain itself re-checks streaming state, so this is a no-op
    // while the turn is still live.
    if (!acceptedLive) {
      const current = getState().session;
      if (current.id === sessionId) {
        const { continueIfTrailingSteer } = await import(
          "./continueIfTrailingSteer"
        );
        void dispatch(continueIfTrailingSteer());
      }
    }
  },
);
