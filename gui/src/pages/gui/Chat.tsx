import { Editor, JSONContent } from "@tiptap/react";
import { ChatHistoryItem, InputModifiers } from "core";
import { TOOL_INTERRUPTED_MESSAGE } from "core/tools/constants";
import { renderChatMessage } from "core/util/messageContent";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ErrorBoundary } from "react-error-boundary";
import styled from "styled-components";
import { Button, lightGray, vscBackground } from "../../components";
import { useFindWidget } from "../../components/find/FindWidget";
import ThinkingBlockPeek from "../../components/mainInput/belowMainInput/ThinkingBlockPeek";
import ContinueInputBox from "../../components/mainInput/ContinueInputBox";
import StepContainer from "../../components/StepContainer";
import { TabBar } from "../../components/TabBar/TabBar";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  selectDoneApplyStates,
  selectPendingToolCalls,
} from "../../redux/selectors/selectToolCalls";
import {
  cancelToolCall,
  ChatHistoryItemWithMessageId,
  newSession,
  updateToolCallOutput,
} from "../../redux/slices/sessionSlice";

import { streamEditThunk } from "../../redux/thunks/edit";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import { isMetaEquivalentKeyPressed } from "../../util";
import { SingleToolCallDiv } from "./ToolCallDiv";
import {
  NestedWorkerCard,
  parseNestedWorkerThinking,
} from "./ToolCallDiv/NestedWorkerCard";

import { useStore } from "react-redux";
import FeedbackDialog from "../../components/dialogs/FeedbackDialog";

import { FatalErrorIndicator } from "../../components/config/FatalErrorNotice";
import InlineErrorMessage from "../../components/mainInput/InlineErrorMessage";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import {
  setDialogMessage,
  setShowDialog,
  setThinkingCollapse,
  setFocusView,
} from "../../redux/slices/uiSlice";
import { RootState } from "../../redux/store";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { getLocalStorage, setLocalStorage } from "../../util/localStorage";
import { EmptyChatBody } from "./EmptyChatBody";
import { ExploreDialogWatcher } from "./ExploreDialogWatcher";
import { useAutoScroll } from "./useAutoScroll";
import {
  CukiiStreamingToolbar,
  CukiiWaitingReceipt,
} from "../../components/mainInput/Lump/LumpToolbar/CukiiStreamingToolbar";
import { CukiiCrumbs } from "../../components/cukii/CukiiCrumbs";
import { CukiiMessageReceiptStatus } from "../../components/cukii/CukiiMessageReceiptStatus";
import { getActiveTimelineToolId, getToolTimelineClass } from "./timelineUtils";
import { dispatchResponseEscape } from "./chatEscape";
import { shouldInterruptFromEscape } from "./interruptShortcut";

// Helper function to find the index of the latest conversation summary
function findLatestSummaryIndex(history: ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) {
      return i;
    }
  }
  return -1; // No summary found
}

function assistantHasVisibleText(item: ChatHistoryItemWithMessageId): boolean {
  const text = renderChatMessage(item.message).trim();
  return (
    text.length > 0 ||
    !!item.conversationSummary ||
    !!item.reasoning?.text?.trim()
  );
}

function formatSteerSentTime(sentAt: number | undefined): string | undefined {
  if (!Number.isFinite(sentAt)) return undefined;
  return new Date(sentAt!).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const StepsDiv = styled.div`
  position: relative;
  background-color: transparent;

  & > * {
    position: relative;
    flex-shrink: 0;
  }

  .thread-message {
    margin: 0;
  }
`;

export const MAIN_EDITOR_INPUT_ID = "main-editor-input";
export const INITIAL_TRANSCRIPT_WINDOW = 160;

function fallbackRender({ error, resetErrorBoundary }: any) {
  // Call resetErrorBoundary() to reset the error boundary and retry the render.

  return (
    <div
      role="alert"
      className="px-2"
      style={{ backgroundColor: vscBackground }}
    >
      <p>Something went wrong:</p>
      <pre style={{ color: "red" }}>{error.message}</pre>
      <pre style={{ color: lightGray }}>{error.stack}</pre>

      <div className="text-center">
        <Button onClick={resetErrorBoundary}>Restart</Button>
      </div>
    </div>
  );
}

export function Chat() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const reduxStore = useStore<RootState>();
  const showSessionTabs = useAppSelector(
    (store) => store.config.config.ui?.showSessionTabs,
  );
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const isCancelling = useAppSelector((state) => state.session.isCancelling);
  const hasPendingPermission = useAppSelector(
    (state) => Object.keys(state.session.pendingClaudePermissions).length > 0,
  );
  const bridgeWait = useAppSelector((state) => state.session.bridgeWait);
  const mainTextInputRef = useRef<HTMLInputElement>(null);
  const stepsDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const history = useAppSelector((state) => state.session.history);
  const sessionId = useAppSelector((state) => state.session.id);
  const isSessionLoading = useAppSelector(
    (state) => state.session.isSessionLoading,
  );
  const [transcriptWindow, setTranscriptWindow] = useState(() => ({
    sessionId,
    visibleCount: INITIAL_TRANSCRIPT_WINDOW,
  }));
  const visibleTranscriptCount =
    transcriptWindow.sessionId === sessionId
      ? transcriptWindow.visibleCount
      : INITIAL_TRANSCRIPT_WINDOW;
  const transcriptStart = Math.max(0, history.length - visibleTranscriptCount);
  const thinkingCollapse = useAppSelector((state) => state.ui.thinkingCollapse);
  const focusView = useAppSelector((state) => state.ui.focusView);
  const showChatScrollbar = useAppSelector(
    (state) => state.config.config.ui?.showChatScrollbar,
  );
  const codeToEdit = useAppSelector((state) => state.editModeState.codeToEdit);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const hasDismissedExploreDialog = useAppSelector(
    (state) => state.ui.hasDismissedExploreDialog,
  );

  useAutoScroll(stepsDivRef, history, isStreaming, sessionId);

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        shouldInterruptFromEscape(e, {
          isStreaming,
          isCancelling: Boolean(isCancelling),
          hasPendingPermission,
        })
      ) {
        dispatchResponseEscape(e, isStreaming, () => {
          void dispatch(cancelStream());
        });
      }
      if (
        e.key.toLowerCase() === "o" &&
        isMetaEquivalentKeyPressed(e) &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        dispatch(setThinkingCollapse(!thinkingCollapse.open));
      }
      if (
        e.key.toLowerCase() === "f" &&
        isMetaEquivalentKeyPressed(e) &&
        e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        dispatch(setFocusView(!focusView));
      }
    };
    window.addEventListener("keydown", listener);

    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [
    isStreaming,
    isCancelling,
    hasPendingPermission,
    isInEdit,
    thinkingCollapse.open,
    focusView,
  ]);

  const { widget, highlights } = useFindWidget(
    stepsDivRef,
    tabsRef,
    isStreaming,
  );

  const sendInput = useCallback(
    (
      editorState: JSONContent,
      modifiers: InputModifiers,
      index?: number,
      editorToClearOnSend?: Editor,
    ) => {
      const stateSnapshot = reduxStore.getState();
      const latestPendingToolCalls = selectPendingToolCalls(stateSnapshot);
      const latestPendingApplyStates = selectDoneApplyStates(stateSnapshot);
      const isCurrentlyInEdit = stateSnapshot.session.isInEdit;
      const codeToEditSnapshot = stateSnapshot.editModeState.codeToEdit;
      const selectedModelByRole =
        stateSnapshot.config.config.selectedModelByRole;
      const currentMode = stateSnapshot.session.mode;

      // Cancel all pending tool calls
      latestPendingToolCalls.forEach((toolCallState) => {
        dispatch(
          cancelToolCall({
            toolCallId: toolCallState.toolCallId,
          }),
        );
      });

      // Reject all pending apply states
      latestPendingApplyStates.forEach((applyState) => {
        if (applyState.status !== "closed") {
          ideMessenger.post("rejectDiff", applyState);
        }
      });
      const model = isCurrentlyInEdit
        ? (selectedModelByRole.edit ?? selectedModelByRole.chat)
        : selectedModelByRole.chat;

      if (!model) {
        return;
      }

      if (isCurrentlyInEdit && codeToEditSnapshot.length === 0) {
        return;
      }

      if (isCurrentlyInEdit) {
        void dispatch(
          streamEditThunk({
            editorState,
            codeToEdit: codeToEditSnapshot,
          }),
        );
      } else {
        void dispatch(streamResponseThunk({ editorState, modifiers, index }));

        if (editorToClearOnSend) {
          editorToClearOnSend.commands.clearContent();
        }
      }

      // Increment localstorage counter for popup
      const currentCount = getLocalStorage("mainTextEntryCounter");
      if (currentCount) {
        setLocalStorage("mainTextEntryCounter", currentCount + 1);
        if (currentCount === 300) {
          dispatch(setDialogMessage(<FeedbackDialog />));
          dispatch(setShowDialog(true));
        }
      } else {
        setLocalStorage("mainTextEntryCounter", 1);
      }
    },
    [dispatch, ideMessenger, reduxStore],
  );

  useWebviewListener(
    "newSession",
    async () => {
      // unwrapResult(response) // errors if session creation failed
      mainTextInputRef.current?.focus?.();
    },
    [mainTextInputRef],
  );

  // Handle partial tool call output for streaming updates
  useWebviewListener(
    "toolCallPartialOutput",
    async (data) => {
      // Update tool call output in Redux store
      dispatch(
        updateToolCallOutput({
          toolCallId: data.toolCallId,
          contextItems: data.contextItems,
        }),
      );
    },
    [dispatch],
  );

  const isLastUserInput = useCallback(
    (index: number): boolean => {
      return !history
        .slice(index + 1)
        .some((entry) => entry.message.role === "user");
    },
    [history],
  );

  const latestSummaryIndex = useMemo(
    () => findLatestSummaryIndex(history),
    [history],
  );
  const activeTimelineToolId = useMemo(
    () => getActiveTimelineToolId(history),
    [history],
  );
  // Rendering belongs to the active stream, not to whether its latest event is
  // a tool call. A tool may be quiet for seconds while the stream is alive.
  const shouldRenderStreamingToolbar = isStreaming && !isInEdit && !bridgeWait;

  const renderTranscriptRows = useCallback((): JSX.Element[] => {
    const transcriptHistory = history.slice(transcriptStart);
    return transcriptHistory.flatMap((item, relativeIndex): JSX.Element[] => {
      const historyIndex = transcriptStart + relativeIndex;
      const {
        message,
        editorState,
        contextItems,
        appliedRules,
        toolCallStates,
      } = item;

      if (item.modelSwitch) {
        const label = `Switched to ${item.modelSwitch.displayName}`;
        return [
          <div
            key={message.id}
            className="cukii-model-switch-divider shrink-0"
            data-testid="cukii-model-switch"
          >
            <span aria-hidden="true" className="cukii-model-switch-wave" />
            <span className="cukii-model-switch-label" title={label}>
              <span className="cukii-model-switch-full">{label}</span>
              <span className="cukii-model-switch-short">Switched model</span>
            </span>
            <span aria-hidden="true" className="cukii-model-switch-wave" />
          </div>,
        ];
      }

      if (message.role === "system" || message.role === "tool") {
        return [];
      }

      const isBeforeLatestSummary =
        latestSummaryIndex !== -1 && historyIndex < latestSummaryIndex;
      const errorBoundary = (content: ReactNode) => (
        <ErrorBoundary
          FallbackComponent={fallbackRender}
          onReset={() => {
            dispatch(newSession());
          }}
        >
          {content}
        </ErrorBoundary>
      );

      if (message.role === "user") {
        const sentTime = formatSteerSentTime(item.messageReceipt?.sentAt);
        const receiptStatus = item.messageReceipt?.status;
        const visualReceiptStatus =
          receiptStatus === "read"
            ? "read"
            : receiptStatus === "queued" ||
                receiptStatus === "delivered" ||
                receiptStatus === "deferred"
              ? "sent"
              : undefined;
        return [
          <div key={message.id} className="cukii-user-row shrink-0">
            <div className="cukii-user-message">
              <div className="cukii-user-message-bubble">
                {errorBoundary(
                  <ContinueInputBox
                    onEnter={(nextEditorState, modifiers) =>
                      sendInput(nextEditorState, modifiers, historyIndex)
                    }
                    isLastUserInput={isLastUserInput(historyIndex)}
                    isMainInput={false}
                    editorState={editorState ?? message.content}
                    contextItems={contextItems}
                    appliedRules={appliedRules}
                    inputId={message.id}
                  />,
                )}
                {sentTime && (
                  <span
                    className="cukii-user-metadata"
                    data-testid={`cukii-message-receipt-${message.id}`}
                    aria-label={
                      visualReceiptStatus === "read"
                        ? `Sent ${sentTime}, read`
                        : receiptStatus === "deferred"
                          ? `Sent ${sentTime}, queued for the next turn`
                          : visualReceiptStatus
                            ? `Sent ${sentTime}, delivered`
                            : `Sent ${sentTime}`
                    }
                  >
                    <time>{sentTime}</time>
                    {visualReceiptStatus && (
                      <CukiiMessageReceiptStatus status={visualReceiptStatus} />
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>,
        ];
      }

      if (message.role === "thinking") {
        const thinkingContent = renderChatMessage(message);
        if (!thinkingContent?.trim()) {
          return [];
        }

        const inProgress =
          isStreaming &&
          (item.reasoning?.active ?? historyIndex === history.length - 1);
        const nestedWorker = parseNestedWorkerThinking(
          thinkingContent,
          inProgress,
        );
        const thinkingBody = nestedWorker ? (
          <NestedWorkerCard view={nestedWorker} />
        ) : (
          <ThinkingBlockPeek
            content={thinkingContent}
            redactedThinking={message.redactedThinking}
            index={historyIndex}
            prevItem={historyIndex > 0 ? history[historyIndex - 1] : null}
            inProgress={inProgress}
            signature={message.signature}
            durationMs={
              item.reasoning?.startAt && item.reasoning.endAt
                ? item.reasoning.endAt - item.reasoning.startAt
                : undefined
            }
          />
        );

        const thinkingRows: JSX.Element[] = [
          <div
            key={message.id}
            className={`cukii-timeline-item cukii-timeline-event cukii-timeline-thinking ${
              inProgress ? "cukii-timeline-thinking-active" : ""
            } shrink-0 ${isBeforeLatestSummary ? "opacity-50" : ""}`}
          >
            {errorBoundary(thinkingBody)}
          </div>,
        ];

        // A cancellation is a terminal event in the same transcript rail as
        // thinking/text. Keeping it as a sibling timeline item preserves the
        // dot, vertical connector and prose inset instead of a detached footer.
        if (item.interrupted) {
          thinkingRows.push(
            <div
              key={`${message.id}-interrupted`}
              className={`cukii-timeline-item cukii-timeline-event cukii-timeline-interrupted shrink-0 ${
                isBeforeLatestSummary ? "opacity-50" : ""
              }`}
            >
              <span
                className="text-description-muted"
                data-testid="turn-interrupted"
              >
                {TOOL_INTERRUPTED_MESSAGE}
              </span>
            </div>,
          );
        }

        return thinkingRows;
      }

      if (message.role === "assistant") {
        const rows: JSX.Element[] = [];

        if (assistantHasVisibleText(item)) {
          rows.push(
            <div
              key={`${message.id}-text`}
              className={`cukii-timeline-item cukii-timeline-event shrink-0 ${isBeforeLatestSummary ? "opacity-50" : ""}`}
            >
              {errorBoundary(
                <div className="thread-message">
                  <StepContainer
                    index={historyIndex}
                    isLast={historyIndex === history.length - 1}
                    item={item}
                    latestSummaryIndex={latestSummaryIndex}
                  />
                </div>,
              )}
            </div>,
          );
        }

        toolCallStates?.forEach((toolCallState) => {
          rows.push(
            <div
              key={toolCallState.toolCallId}
              data-cukii-active={
                toolCallState.toolCallId === activeTimelineToolId
                  ? "true"
                  : undefined
              }
              className={`cukii-timeline-item shrink-0 ${getToolTimelineClass(
                toolCallState.status,
                toolCallState.toolCallId === activeTimelineToolId,
              )} ${isBeforeLatestSummary ? "opacity-50" : ""}`}
            >
              {errorBoundary(
                <SingleToolCallDiv
                  toolCallState={toolCallState}
                  historyIndex={historyIndex}
                />,
              )}
            </div>,
          );
        });

        // Always show turn cancellation as a normal timeline row, regardless
        // of whether a tool has a separate per-tool interruption label.
        if (item.interrupted) {
          rows.push(
            <div
              key={`${message.id}-interrupted`}
              className={`cukii-timeline-item cukii-timeline-event cukii-timeline-interrupted shrink-0 ${
                isBeforeLatestSummary ? "opacity-50" : ""
              }`}
            >
              <span
                className="text-description-muted"
                data-testid="turn-interrupted"
              >
                {TOOL_INTERRUPTED_MESSAGE}
              </span>
            </div>,
          );
        }

        return rows;
      }

      return [];
    });
  }, [
    dispatch,
    history,
    isLastUserInput,
    isStreaming,
    activeTimelineToolId,
    latestSummaryIndex,
    sendInput,
    transcriptStart,
  ]);

  const showScrollbar = showChatScrollbar ?? window.innerHeight > 5000;

  return (
    <>
      {!!showSessionTabs && window.cukiiSurface !== "chat" && !isInEdit && (
        <TabBar ref={tabsRef} />
      )}
      {widget}

      <StepsDiv
        ref={stepsDivRef}
        className={`cukii-transcript ${isStreaming ? "cukii-transcript-streaming" : ""} flex min-h-0 min-w-0 flex-1 flex-col overflow-y-scroll ${showScrollbar ? "thin-scrollbar" : "no-scrollbar"}`}
      >
        {highlights}
        {isSessionLoading ? (
          <div
            aria-live="polite"
            className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[13px] text-[var(--vscode-descriptionForeground)]"
            data-testid="cukii-session-loading"
            role="status"
          >
            <CukiiCrumbs />
            <span>Loading…</span>
          </div>
        ) : (
          <>
            {history.length === 0 && <EmptyChatBody sessionId={sessionId} />}
            {transcriptStart > 0 && (
              <button
                type="button"
                className="cukii-load-earlier mx-auto my-3 rounded px-3 py-1 text-[12px] text-[var(--vscode-descriptionForeground)]"
                onClick={() =>
                  setTranscriptWindow({
                    sessionId,
                    visibleCount:
                      visibleTranscriptCount + INITIAL_TRANSCRIPT_WINDOW,
                  })
                }
              >
                Load earlier messages
              </button>
            )}
            {renderTranscriptRows()}
          </>
        )}
        <InlineErrorMessage />
        {isStreaming &&
          !isInEdit &&
          (bridgeWait ? (
            <CukiiWaitingReceipt wait={bridgeWait} />
          ) : shouldRenderStreamingToolbar ? (
            <div
              className="cukii-spinner-row"
              data-testid="cukii-spinner-row"
              data-cukii-active="true"
            >
              <CukiiStreamingToolbar active />
            </div>
          ) : null)}
      </StepsDiv>
      {!isSessionLoading && (
        <div className={"cukii-main-input-shell relative shrink-0"}>
          <ContinueInputBox
            isMainInput
            isLastUserInput={false}
            onEnter={(editorState, modifiers, editor) =>
              sendInput(editorState, modifiers, undefined, editor)
            }
            inputId={MAIN_EDITOR_INPUT_ID}
          />

          <div
            style={{
              pointerEvents: isStreaming ? "none" : "auto",
            }}
          >
            <FatalErrorIndicator />
            {!hasDismissedExploreDialog && <ExploreDialogWatcher />}
          </div>
        </div>
      )}
    </>
  );
}
