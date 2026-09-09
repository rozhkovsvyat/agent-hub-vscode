import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";

import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { isCompactSlashCommand } from "../../util/isCompactSlashCommand";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  resetNextCodeBlockToApplyIndex,
  submitEditorAndInitAtIndex,
  updateHistoryItemAtIndex,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { compactConversationThunk } from "./compactConversation";
import { saveCurrentSession } from "./session";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";
import { updateFileSymbolsFromFiles } from "./updateFileSymbols";

const activeNormalSubmissions = new WeakMap<object, string>();

export const streamResponseThunk = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async ({ editorState, modifiers, index }, { dispatch, extra, getState }) => {
    const initialState = getState();
    const dispatchKey = dispatch as unknown as object;
    const submissionKey = JSON.stringify({ editorState, modifiers, index });
    const activeSubmission = activeNormalSubmissions.get(dispatchKey);

    if (
      initialState.session.isStreaming &&
      activeSubmission === submissionKey
    ) {
      // A key-repeat can invoke the same React callback again before the
      // synchronous Redux claim reaches isStreamingRef. It is the same
      // captured submit, not a second steering message.
      return;
    }

    if (initialState.session.isStreaming && index === undefined) {
      // React may still render the idle submit path for one event after Redux
      // has synchronously claimed the turn below. Preserve that captured input
      // as steering instead of starting a second normal vendor run.
      const { steerDuringStream } = await import("./steerDuringStream");
      await dispatch(steerDuringStream({ editorState, modifiers }));
      return;
    }

    activeNormalSubmissions.set(dispatchKey, submissionKey);
    try {
      if (isCompactSlashCommand(editorState)) {
        await dispatch(
          streamThunkWrapper(async () => {
            const compactIndex = getState().session.history.length - 1;
            if (compactIndex >= 0 && getState().session.id) {
              await dispatch(compactConversationThunk({ index: compactIndex }));
            }
          }),
        );
        return;
      }

      // 🔴 The broker talks to vendor CLIs and never reads a Continue model, so
      // this inherited gate must not stand in front of it. Cukii ships an empty
      // `~/.continue/config.yaml`, so on a fresh install every broker turn hit
      // this branch and silently refused to send — which is what made a helper
      // agent ask the owner which model to write into that file.
      if (
        initialState.session.mode !== "broker" &&
        !selectSelectedChatModel(initialState)
      ) {
        await dispatch(
          streamThunkWrapper(async () => {
            throw new Error("No chat model selected");
          }),
        );
        const { continueIfTrailingSteer } = await import(
          "./continueIfTrailingSteer"
        );
        await dispatch(continueIfTrailingSteer());
        return;
      }

      const inputIndex = index ?? initialState.session.history.length;
      // Render and claim the turn before the first async persistence/context
      // boundary. Besides making the user's text visible immediately, setActive
      // prevents rapid Enter presses from starting parallel normal turns while
      // the durable pre-save is blocked.
      dispatch(submitEditorAndInitAtIndex({ index: inputIndex, editorState }));
      const messageId = getState().session.history[inputIndex]?.message.id;
      if (!messageId) {
        throw new Error("Failed to initialize the user turn");
      }
      dispatch(resetNextCodeBlockToApplyIndex());

      await dispatch(
        streamThunkWrapper(async () => {
          const state = getState();

          const defaultContextProviders =
            state.config.config.experimental?.defaultContext ?? [];

          // Resolve context providers and construct new history
          const {
            selectedContextItems,
            selectedCode,
            content,
            legacyCommandWithInput,
          } = await resolveEditorContent({
            editorState,
            modifiers,
            ideMessenger: extra.ideMessenger,
            defaultContextProviders,
            availableSlashCommands: state.config.config.slashCommands,
            dispatch,
            getState,
          });

          // symbols for both context items AND selected codeblocks
          const filesForSymbols = [
            ...selectedContextItems
              .filter((item) => item.uri?.type === "file" && item?.uri?.value)
              .map((item) => item.uri!.value),
            ...selectedCode.map((rif) => rif.filepath),
          ];
          void dispatch(updateFileSymbolsFromFiles(filesForSymbols));

          dispatch(
            updateHistoryItemAtIndex({
              index: inputIndex,
              updates: {
                message: {
                  role: "user",
                  content,
                  id: messageId,
                },
                contextItems: selectedContextItems,
              },
            }),
          );

          // Persist the resolved payload before vendor dispatch. The wrapper's
          // pre-save already made the optimistic bubble durable; this second
          // save upgrades it with resolved context/content while preserving its
          // identity.
          if (!getState().session.isInEdit) {
            const earlySave = dispatch(
              saveCurrentSession({
                openNewSession: false,
                generateTitle: false,
                provisionalTitle: true,
              }),
            );
            void earlySave.catch(() => undefined);
            await earlySave.catch(() => undefined);
          }

          unwrapResult(
            await dispatch(
              streamNormalInput({
                legacySlashCommandData: legacyCommandWithInput
                  ? {
                      command: legacyCommandWithInput.command,
                      contextItems: selectedContextItems,
                      historyIndex: inputIndex,
                      input: legacyCommandWithInput.input,
                      selectedCode,
                    }
                  : undefined,
              }),
            ),
          );
        }),
      );
      const { continueIfTrailingSteer } = await import(
        "./continueIfTrailingSteer"
      );
      await dispatch(continueIfTrailingSteer());
    } finally {
      if (activeNormalSubmissions.get(dispatchKey) === submissionKey) {
        activeNormalSubmissions.delete(dispatchKey);
      }
    }
  },
);
