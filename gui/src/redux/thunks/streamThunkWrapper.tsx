import { createAsyncThunk } from "@reduxjs/toolkit";

import StreamErrorDialog from "../../pages/gui/StreamError";
import { analyzeError } from "../../util/errorAnalysis";

const OVERLOADED_RETRIES = 3;
const OVERLOADED_DELAY_MS = 2000;

function isOverloadedErrorMessage(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("overloaded") || lower.includes("529");
}
import { selectSelectedChatModel } from "../slices/configSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { saveCurrentSession } from "./session";

type StreamThunkTask =
  | (() => Promise<void>)
  | {
      runStream: () => Promise<void>;
      /** Submission ownership is checked after every await. A stopped turn may
       * finish old persistence/context work, but it must never cancel or show
       * an error over a replacement turn. */
      isCurrent: () => boolean;
      isCancelled: () => boolean;
      /** Adopt the AbortController created by this wrapper's own recovery
       * cancel. A later user Stop rotates it again and still invalidates retry. */
      adoptCancellationBoundary: () => void;
    };

export const streamThunkWrapper = createAsyncThunk<
  void,
  StreamThunkTask,
  ThunkApiType
>("chat/streamWrapper", async (task, { dispatch, getState }) => {
  const runStream = typeof task === "function" ? task : task.runStream;
  const isCurrent = () =>
    typeof task === "function" ? true : task.isCurrent();
  const isCancelled = () =>
    typeof task === "function" ? false : task.isCancelled();
  for (let attempt = 0; attempt <= OVERLOADED_RETRIES; attempt++) {
    if (!isCurrent() || isCancelled()) return;
    try {
      const preState = getState();
      if (!preState.session.isInEdit) {
        // Persist the user turn before the vendor round-trip. The session row
        // must appear in the journal immediately after the chat starts, and
        // the conversation must survive a window reload that lands mid-turn;
        // waiting for the full turn to finish leaves long broker runs
        // invisible and unrecoverable. provisionalTitle keeps the fallback
        // title out of the live header so a later end-of-turn save can still
        // upgrade a fresh session to its semantic title.
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: false,
            provisionalTitle: true,
          }),
        );
        if (!isCurrent() || isCancelled()) return;
      }
      await runStream();
      // A user Stop may resolve the active stream normally. Preserve its
      // partial transcript, but only while no newer submission owns the turn.
      if (!isCurrent()) return;
      const state = getState();
      if (!state.session.isInEdit) {
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: true,
          }),
        );
      }
      return;
    } catch (e) {
      if (!isCurrent() || isCancelled()) return;
      // The partial turn is the user's work too. Persist it before any retry
      // or error dialog so a reload cannot drop what already happened.
      if (!getState().session.isInEdit) {
        const rescueSave = dispatch(
          saveCurrentSession({ openNewSession: false, generateTitle: false }),
        );
        void rescueSave.catch(() => undefined);
        await rescueSave.catch(() => undefined);
        if (!isCurrent() || isCancelled()) return;
      }
      // Get the selected model from the state for error analysis
      const state = getState();
      const selectedModel = selectSelectedChatModel(state);
      const { message } = analyzeError(e, selectedModel);

      const shouldRetry =
        isOverloadedErrorMessage(message) && attempt < OVERLOADED_RETRIES;

      if (shouldRetry) {
        const recoveryCancel = dispatch(cancelStream({ source: "error" }));
        // cancelStream rotates the AbortController synchronously before its
        // native receipt await. Adopt exactly that internal boundary now. If
        // the user presses Stop while the receipt is pending, abortStream
        // rotates once more and isCancelled() remains true after the await.
        if (typeof task !== "function") task.adoptCancellationBoundary();
        await recoveryCancel;
        if (!isCurrent() || isCancelled()) return;
        const delayMs = OVERLOADED_DELAY_MS * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!isCurrent() || isCancelled()) return;
        const retryBoundary = dispatch(cancelStream({ source: "error" }));
        if (typeof task !== "function") task.adoptCancellationBoundary();
        await retryBoundary;
        if (!isCurrent() || isCancelled()) return;
      } else {
        const errorCancel = dispatch(cancelStream({ source: "error" }));
        if (typeof task !== "function") task.adoptCancellationBoundary();
        await errorCancel;
        if (!isCurrent() || isCancelled()) return;
        dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
        dispatch(setShowDialog(true));

        return;
      }
    }
  }
});
