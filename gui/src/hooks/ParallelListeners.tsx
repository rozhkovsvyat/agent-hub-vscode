import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../context/IdeMessenger";

import { FromCoreProtocol } from "core/protocol";
import { useAppDispatch, useAppSelector } from "../redux/hooks";
import { setConfigLoading, setConfigResult } from "../redux/slices/configSlice";
import { setLastNonEditSessionEmpty } from "../redux/slices/editState";
import { updateIndexingStatus } from "../redux/slices/indexingSlice";
import {
  initializeProfilePreferences,
  setProfiles,
  setSelectedProfile,
} from "../redux/slices/profilesSlice";
import {
  addContextItemsAtIndex,
  newSession,
  setHasReasoningEnabled,
  setIsSessionLoading,
  setIsSessionMetadataLoading,
  setMode,
  setTitleManuallySet,
  updateSessionTitle,
} from "../redux/slices/sessionSlice";
import { setTTSActive } from "../redux/slices/uiSlice";

import { modelSupportsReasoning } from "core/llm/autodetect";
import { cancelStream } from "../redux/thunks/cancelStream";
import { isRestorableCukiiSession } from "./cukiiSessionRestore";
import { handleApplyStateUpdate } from "../redux/thunks/handleApplyStateUpdate";
import {
  getSession,
  refreshSessionMetadata,
  selectChatModelForProfile,
} from "../redux/thunks/session";
import { updateFileSymbolsFromHistory } from "../redux/thunks/updateFileSymbols";
import {
  setDocumentStylesFromLocalStorage,
  setDocumentStylesFromTheme,
} from "../styles/theme";
import { isJetBrains } from "../util";
import { setLocalStorage } from "../util/localStorage";
import { migrateLocalStorage } from "../util/migrateLocalStorage";
import { useWebviewListener } from "./useWebviewListener";

function ParallelListeners() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const history = useAppSelector((store) => store.session.history);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const mode = useAppSelector((store) => store.session.mode);
  const selectedProfileId = useAppSelector(
    (store) => store.profiles.selectedProfileId,
  );
  const reasoningSettings = useAppSelector(
    (store) => store.ui.reasoningSettings,
  );
  const hasDoneInitialConfigLoad = useRef(false);
  const initialLoadInFlight = useRef(false);

  // Load symbols for chat on any session change
  const sessionId = useAppSelector((state) => state.session.id);
  const sessionTitle = useAppSelector((state) => state.session.title);
  const historyLength = useAppSelector((state) => state.session.history.length);
  const lastSessionId = useAppSelector((store) => store.session.lastSessionId);
  const [initialSessionId] = useState(
    window.cukiiSurface === "chat"
      ? window.initialSessionId || undefined
      : sessionId || lastSessionId,
  );

  useWebviewListener("cukii/getActiveSessionId", async () => sessionId || "");

  useEffect(() => {
    if (window.cukiiSurface !== "chat" || !sessionId || historyLength === 0) {
      return;
    }
    window.cukiiVscode?.setState({
      ...(window.cukiiVscode?.getState() ?? {}),
      sessionId,
      title: sessionTitle,
      // The panel serializer revives this id after a window restart so the
      // tab rehydrates its own persisted state instead of a foreign one.
      panelId: window.cukiiPanelId,
    });
    ideMessenger.post("cukii/panelSessionChanged", {
      sessionId,
      title: sessionTitle,
    });
  }, [ideMessenger, sessionId, sessionTitle, historyLength]);

  useWebviewListener(
    "cukii/sessionTitleChanged",
    async ({ sessionId: changedSessionId, title, titleManuallySet }) => {
      if (changedSessionId !== sessionId) {
        return;
      }
      dispatch(updateSessionTitle(title));
      if (titleManuallySet) {
        dispatch(setTitleManuallySet(true));
      }
    },
    [dispatch, sessionId],
  );

  const handleConfigUpdate = useCallback(
    async (isInitial: boolean, result: FromCoreProtocol["configUpdate"][0]) => {
      const { result: configResult, profileId, profiles } = result;
      if (isInitial && hasDoneInitialConfigLoad.current) {
        return;
      }
      if (configResult.configLoadInterrupted || !configResult.config) {
        return;
      }
      hasDoneInitialConfigLoad.current = true;
      dispatch(setProfiles(profiles));
      dispatch(setSelectedProfile(profileId));
      dispatch(setConfigResult(configResult));

      const isNewProfileId = profileId && profileId !== selectedProfileId;

      if (isNewProfileId) {
        dispatch(
          initializeProfilePreferences({
            defaultSlashCommands: [],
            profileId,
          }),
        );
      }

      // Perform any actions needed with the config
      if (configResult.config?.ui?.fontSize) {
        setLocalStorage("fontSize", configResult.config.ui.fontSize);
        document.body.style.fontSize = `${configResult.config.ui.fontSize}px`;
      }

      if (mode !== "broker") {
        const chatModel = configResult.config?.selectedModelByRole.chat;
        const supportsReasoning = modelSupportsReasoning(chatModel);
        const isReasoningDisabled =
          chatModel?.completionOptions?.reasoning === false;
        const wasReasoningPreviouslyEnabled = chatModel?.title
          ? reasoningSettings[chatModel.title] !== false
          : true;
        dispatch(
          setHasReasoningEnabled(
            supportsReasoning &&
              !isReasoningDisabled &&
              wasReasoningPreviouslyEnabled,
          ),
        );
      }
    },
    [
      dispatch,
      hasDoneInitialConfigLoad,
      mode,
      selectedProfileId,
      reasoningSettings,
    ],
  );

  // Load config from the IDE
  useEffect(() => {
    async function initialLoadConfig() {
      if (initialLoadInFlight.current) return;
      initialLoadInFlight.current = true;
      dispatch(setIsSessionMetadataLoading(true));
      dispatch(setConfigLoading(true));
      if (initialSessionId) dispatch(setIsSessionLoading(true));
      try {
        // Large saved chats can be tens of megabytes. Fetch config and history
        // concurrently, while the chat shows one centered Loading… state.
        const [configResult, sessionResult] = await Promise.all([
          ideMessenger.request("config/getSerializedProfileInfo", undefined),
          initialSessionId
            ? getSession(ideMessenger, initialSessionId).then(
                (session) => ({ session }),
                (error: unknown) => ({ error }),
              )
            : Promise.resolve(undefined),
        ]);
        if (configResult.status === "success") {
          await handleConfigUpdate(true, configResult.content);
        }
        if (
          sessionResult &&
          "session" in sessionResult &&
          isRestorableCukiiSession(sessionResult.session)
        ) {
          dispatch(newSession(sessionResult.session));
          if (sessionResult.session.chatModelTitle) {
            void dispatch(
              selectChatModelForProfile(sessionResult.session.chatModelTitle),
            );
          }
        } else if (initialSessionId && sessionResult) {
          // This panel was explicitly created for a persisted session. It
          // must not silently become a blank tab (or replace any active
          // session) if that session vanished after the extension preflight.
          if ("error" in sessionResult) {
            console.error("Failed to load Cukii session", sessionResult.error);
          }
          ideMessenger.post("cukii/initialSessionLoadFailed", {
            sessionId: initialSessionId,
          });
        } else if (window.cukiiSurface === "chat") {
          dispatch(newSession());
        }
      } finally {
        dispatch(setConfigLoading(false));
        dispatch(setIsSessionLoading(false));
        initialLoadInFlight.current = false;
      }
    }
    void initialLoadConfig();
    const interval = setInterval(() => {
      if (hasDoneInitialConfigLoad.current) {
        // Init to run on initial config load
        ideMessenger.post("docs/initStatuses", undefined);
        void dispatch(updateFileSymbolsFromHistory());
        void dispatch(refreshSessionMetadata({}));

        // This triggers sending pending status to the GUI for relevant docs indexes
        clearInterval(interval);
      } else {
        void initialLoadConfig();
      }
    }, 2_000);

    return () => clearInterval(interval);
  }, [hasDoneInitialConfigLoad, ideMessenger, initialSessionId]);

  useWebviewListener(
    "configUpdate",
    async (update) => {
      if (!update) {
        return;
      }
      await handleConfigUpdate(false, update);
    },
    [handleConfigUpdate],
  );

  useEffect(() => {
    if (sessionId) {
      void dispatch(updateFileSymbolsFromHistory());
    }
  }, [sessionId]);

  // ON LOAD
  useEffect(() => {
    // Override persisted state
    void dispatch(cancelStream({ source: "lifecycle" }));

    const jetbrains = isJetBrains();
    setDocumentStylesFromLocalStorage(jetbrains);

    if (jetbrains) {
      // Save theme colors to local storage for immediate loading in JetBrains
      void ideMessenger
        .request("jetbrains/getColors", undefined)
        .then((result) => {
          if (result.status === "success") {
            setDocumentStylesFromTheme(result.content);
          }
        });

      // Tell JetBrains the webview is ready
      void ideMessenger
        .request("jetbrains/onLoad", undefined)
        .then((result) => {
          if (result.status === "error") {
            return;
          }

          const msg = result.content;
          (window as any).windowId = msg.windowId;
          (window as any).serverUrl = msg.serverUrl;
          (window as any).workspacePaths = msg.workspacePaths;
          (window as any).vscMachineId = msg.vscMachineId;
          (window as any).vscMediaUrl = msg.vscMediaUrl;
        });
    }
  }, []);

  useWebviewListener(
    "jetbrains/setColors",
    async (data) => {
      setDocumentStylesFromTheme(data);
    },
    [],
  );

  // IDE event listeners
  useWebviewListener(
    "getWebviewHistoryLength",
    async () => {
      return history.length;
    },
    [history],
  );

  useWebviewListener(
    "getCurrentSessionId",
    async () => {
      return sessionId;
    },
    [sessionId],
  );

  useWebviewListener("setInactive", async () => {
    void dispatch(cancelStream({ source: "lifecycle" }));
  });

  useWebviewListener("setTTSActive", async (status) => {
    dispatch(setTTSActive(status));
  });

  useWebviewListener("addContextItem", async (data) => {
    dispatch(
      addContextItemsAtIndex({
        index: data.historyIndex,
        contextItems: [data.item],
      }),
    );
  });

  useWebviewListener("indexing/statusUpdate", async (data) => {
    dispatch(updateIndexingStatus(data));
  });

  useWebviewListener(
    "updateApplyState",
    async (state) => {
      void dispatch(handleApplyStateUpdate(state));
    },
    [],
  );

  useEffect(() => {
    if (!isInEdit) {
      dispatch(setLastNonEditSessionEmpty(history.length === 0));
    }
  }, [isInEdit, history]);

  useEffect(() => {
    migrateLocalStorage(dispatch);
  }, []);

  return <></>;
}

export default ParallelListeners;
