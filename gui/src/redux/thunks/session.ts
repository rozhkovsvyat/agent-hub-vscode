import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { BaseSessionMetadata, ChatMessage, Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { renderChatMessage } from "core/util/messageContent";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSelectedChatModel } from "../slices/configSlice";
import { selectSelectedProfile } from "../slices/profilesSlice";
import {
  deleteSessionMetadata,
  newSession,
  setAllSessionMetadata,
  setIsSessionMetadataLoading,
  setSessionRevision,
  setTitleManuallySet,
  updateSessionTitle,
  updateSessionMetadata,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { updateSelectedModelByRole } from "../thunks/updateSelectedModelByRole";

const MAX_TITLE_LENGTH = 100;

// Async session functions live in thunks (because of IDE messaging mostly)
// see sessionSlice for sync redux session functions

export async function getSession(
  ideMessenger: IIdeMessenger,
  id: string,
): Promise<Session> {
  const result = await ideMessenger.request("history/load", { id });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.content;
}

export const refreshSessionMetadata = createAsyncThunk<
  BaseSessionMetadata[],
  {
    offset?: number;
    limit?: number;
  },
  ThunkApiType
>("session/refreshMetadata", async ({ offset, limit }, { dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/list", {
    limit,
    offset,
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  dispatch(setIsSessionMetadataLoading(false));
  dispatch(setAllSessionMetadata(result.content));
  return result.content;
});

export const deleteSession = createAsyncThunk<void, string, ThunkApiType>(
  "session/delete",
  async (id, { getState, dispatch, extra }) => {
    dispatch(deleteSessionMetadata(id)); // optimistic
    const state = getState();
    if (id === state.session.id) {
      await dispatch(loadLastSession());
    }
    const result = await extra.ideMessenger.request("history/delete", { id });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    void dispatch(refreshSessionMetadata({}));
  },
);

export const updateSession = createAsyncThunk<void, Session, ThunkApiType>(
  "session/update",
  async (session, { extra, dispatch, getState }) => {
    dispatch(
      updateSessionMetadata({
        sessionId: session.sessionId,
        title: session.title,
      }),
    ); // optimistic session metadata update
    const saved = await extra.ideMessenger.request("history/save", session);
    if (saved.status === "success") {
      dispatch(
        setSessionRevision({
          sessionId: saved.content.sessionId,
          revision: saved.content.revision ?? 0,
        }),
      );
      // The persistence boundary is authoritative when it resolved a stale
      // request against a manual rename. This catches a rename event that
      // reached the IDE just before/after this webview's local state update.
      if (
        saved.content.titleManuallySet &&
        getState().session.id === saved.content.sessionId
      ) {
        dispatch(updateSessionTitle(saved.content.title));
        dispatch(setTitleManuallySet(true));
      }
    }
    await dispatch(refreshSessionMetadata({}));
  },
);

/*
 this is only used for the custom focusContinueSessionId command at the moment
*/
export const loadSession = createAsyncThunk<
  void,
  {
    sessionId: string;
    saveCurrentSession: boolean;
  },
  ThunkApiType
>(
  "session/load",
  async ({ sessionId, saveCurrentSession: save }, { extra, dispatch }) => {
    if (save) {
      // save the session in the background
      void dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        }),
      );
    }
    const session = await getSession(extra.ideMessenger, sessionId);
    dispatch(newSession(session));

    // Restore selected chat model from session, if present
    if (session.chatModelTitle) {
      void dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
    const { continueIfTrailingSteer } =
      await import("./continueIfTrailingSteer");
    void dispatch(continueIfTrailingSteer());
  },
);

export const selectChatModelForProfile = createAsyncThunk<
  void,
  string,
  ThunkApiType
>(
  "session/selectModelForCurrentProfile",
  async (modelTitle, { extra, dispatch, getState }) => {
    const state = getState();
    const modelMatch = state.config.config?.modelsByRole?.chat?.find(
      (m) => m.title === modelTitle,
    );
    const selectedProfile = selectSelectedProfile(state);
    if (selectedProfile && modelMatch) {
      await dispatch(
        updateSelectedModelByRole({
          role: "chat",
          modelTitle: modelTitle,
          selectedProfile,
        }),
      );
    }
  },
);

export const loadLastSession = createAsyncThunk<void, void, ThunkApiType>(
  "session/loadLast",
  async (_, { extra, dispatch, getState }) => {
    let lastSessionId = getState().session.lastSessionId;

    // const lastSessionResult = await extra.ideMessenger.request("history/list", {
    //   limit: 1,
    // });
    // if (lastSessionResult.status === "success") {
    //   lastSessionId = lastSessionResult.content.at(0)?.sessionId;
    // }

    if (!lastSessionId) {
      dispatch(newSession());
      return;
    }

    let session: Session;
    try {
      session = await getSession(extra.ideMessenger, lastSessionId);
    } catch {
      // retry again after 1 sec
      await new Promise((resolve) => setTimeout(resolve, 1000));
      session = await getSession(extra.ideMessenger, lastSessionId);
    }
    dispatch(newSession(session));
    if (session.chatModelTitle) {
      dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
    const { continueIfTrailingSteer } =
      await import("./continueIfTrailingSteer");
    void dispatch(continueIfTrailingSteer());
  },
);

function getChatTitleFromMessage(message: ChatMessage) {
  const text =
    renderChatMessage(message)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-1)[0] || "";

  // Truncate
  if (text.length > MAX_TITLE_LENGTH) {
    return text.slice(0, MAX_TITLE_LENGTH - 3) + "...";
  }
  return text;
}

export const saveCurrentSession = createAsyncThunk<
  void,
  { openNewSession: boolean; generateTitle: boolean },
  ThunkApiType
>(
  "session/saveCurrent",
  async ({ openNewSession, generateTitle }, { dispatch, extra, getState }) => {
    const session = getState().session; // assign to a variable so that even when current session changes, we have the reference to the old session
    if (session.history.length === 0) {
      return;
    }

    if (openNewSession) {
      dispatch(newSession());
    }

    const selectedChatModel = selectSelectedChatModel(getState());

    // New session has already been dispatched
    // Now save previous session and update chat title if relevant
    let title = session.title;
    let titleManuallySet = session.titleManuallySet;
    let waitedForAutoTitle = false;
    if (!titleManuallySet) {
      if (title === NEW_SESSION_TITLE) {
        if (
          !getState().config.config?.disableSessionTitles &&
          selectedChatModel
        ) {
          let assistantResponse = session.history
            ?.filter((h) => h.message.role === "assistant")[0]
            ?.message?.content?.toString();

          if (assistantResponse && generateTitle) {
            try {
              waitedForAutoTitle = true;
              const result = await extra.ideMessenger.request(
                "chatDescriber/describe",
                {
                  text: assistantResponse,
                },
              );
              if (result.status === "success" && result.content) {
                title = result.content;
              }
            } catch (e) {
              console.error("Error generating chat title", e);
            }
          }
        }
        // Fallbacks if above doesn't work out or session titles disabled
        if (title === NEW_SESSION_TITLE) {
          title = getChatTitleFromMessage(session.history[0].message);
        }
      }
      // More fallbacks in case of no title
      if (!title.length) {
        const metadata = session.allSessionMetadata.find(
          (m) => m.sessionId === session.id,
        );
        if (metadata?.title) {
          title = metadata.title;
        }
      }
      if (!title.length) {
        title = NEW_SESSION_TITLE;
      }
    }

    // A manual rename can land while chatDescriber/describe is awaiting. The
    // current Redux state is the fast path; history/load is the durable source
    // when the IDE has persisted the rename before its webview event arrives.
    if (waitedForAutoTitle) {
      const currentSession = getState().session;
      if (currentSession.id === session.id && currentSession.titleManuallySet) {
        title = currentSession.title;
        titleManuallySet = true;
      } else {
        const persisted = await extra.ideMessenger.request("history/load", {
          id: session.id,
        });
        if (
          persisted.status === "success" &&
          persisted.content.titleManuallySet
        ) {
          title = persisted.content.title;
          titleManuallySet = true;
        }
      }
    }

    // Only update the live tab after resolving a possible concurrent manual
    // rename. Updating it earlier could replace the manual title before the
    // check above reads it.
    // There are no awaits between this read and the following dispatches. This
    // closes the remaining window where the native rename event could land
    // after the earlier (post-describer) check, but before we update Redux.
    const liveSession = getState().session;
    if (liveSession.id === session.id && liveSession.titleManuallySet) {
      title = liveSession.title;
      titleManuallySet = true;
    }
    if (liveSession.id === session.id && liveSession.title !== title) {
      dispatch(updateSessionTitle(title));
    }
    if (
      liveSession.id === session.id &&
      titleManuallySet &&
      !liveSession.titleManuallySet
    ) {
      dispatch(setTitleManuallySet(true));
    }

    const updatedSession: Session = {
      sessionId: session.id,
      title,
      workspaceDirectory: window.workspacePaths?.[0] || "",
      history: session.history,
      mode: session.mode,
      chatModelTitle: selectedChatModel?.title ?? null,
      brokerModel: session.brokerModel,
      brokerSubagent: session.brokerSubagent,
      brokerEffort: session.brokerEffort,
      brokerSpeed: session.brokerSpeed,
      hasReasoningEnabled: session.hasReasoningEnabled,
      brokerPermissionMode: session.brokerPermissionMode,
      titleManuallySet: titleManuallySet || undefined,
      revision: session.revision,
    };

    const result = await dispatch(updateSession(updatedSession));
    unwrapResult(result);
  },
);
