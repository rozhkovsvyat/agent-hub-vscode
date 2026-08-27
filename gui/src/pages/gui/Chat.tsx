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
  type ReactNode,
} from "react";
import { ErrorBoundary } from "react-error-boundary";
import styled from "styled-components";
import { Button, lightGray, vscBackground } from "../../components";
import { useFindWidget } from "../../components/find/FindWidget";
import ThinkingBlockPeek from "../../components/mainInput/belowMainInput/ThinkingBlockPeek";
import ContinueInputBox from "../../components/mainInput/ContinueInputBox";
import { useOnboardingCard } from "../../components/OnboardingCard";
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

import { DeprecationBanner } from "../../components/DeprecationBanner";
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
import { CukiiStreamingToolbar } from "../../components/mainInput/Lump/LumpToolbar/CukiiStreamingToolbar";
import {
  getLastInProgressToolCallId,
  getToolTimelineClass,
} from "./timelineUtils";

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

function isLastAgentTurn(
  visibleHistory: ChatHistoryItemWithMessageId[],
  index: number,
): boolean {
  return visibleHistory
    .slice(index + 1)
    .every((entry) => entry.message.role === "tool");
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
  const onboardingCard = useOnboardingCard();
  const showSessionTabs = useAppSelector(
    (store) => store.config.config.ui?.showSessionTabs,
  );
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const mainTextInputRef = useRef<HTMLInputElement>(null);
  const stepsDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const history = useAppSelector((state) => state.session.history);
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

  useAutoScroll(stepsDivRef, history, isStreaming);

  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        isStreaming &&
        !e.defaultPrevented &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      ) {
        e.preventDefault();
        void dispatch(cancelStream());
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
  }, [isStreaming, isInEdit, thinkingCollapse.open, focusView]);

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

  const renderTranscriptRows = useCallback((): JSX.Element[] => {
    const visibleHistory = history.filter(
      (item) => item.message.role !== "system",
    );

    return history.flatMap((item, historyIndex): JSX.Element[] => {
      const {
        message,
        editorState,
        contextItems,
        appliedRules,
        toolCallStates,
      } = item;

      if (message.role === "system" || message.role === "tool") {
        return [];
      }

      const visibleIndex = visibleHistory.findIndex(
        (entry) => entry.message.id === message.id,
      );
      const isBeforeLatestSummary =
        latestSummaryIndex !== -1 && historyIndex < latestSummaryIndex;
      const isLiveTurn =
        isStreaming && isLastAgentTurn(visibleHistory, visibleIndex);
      const lastInProgressToolCallId = isLiveTurn
        ? getLastInProgressToolCallId(toolCallStates)
        : undefined;
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
        return [
          <div key={message.id} className="cukii-user-row shrink-0">
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
          </div>,
        ];
      }

      if (message.role === "thinking") {
        const thinkingContent = renderChatMessage(message);
        if (!thinkingContent?.trim()) {
          return [];
        }

        const inProgress = historyIndex === history.length - 1 && isStreaming;
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
          />
        );

        const thinkingRows: JSX.Element[] = [
          <div
            key={message.id}
            className={`cukii-timeline-item cukii-timeline-event shrink-0 ${
              isLiveTurn && inProgress ? "cukii-timeline-current" : ""
            } ${isBeforeLatestSummary ? "opacity-50" : ""}`}
          >
            {errorBoundary(thinkingBody)}
          </div>,
        ];

        // Turn-level "Interrupted" fact for canceled thinking-only streams.
        // Render it as plain muted text (Claude parity), not a timeline event
        // with a red dot.
        if (item.interrupted) {
          thinkingRows.push(
            <div
              key={`${message.id}-interrupted`}
              className={`cukii-interrupted-fact mt-2 min-w-0 ${
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
              className={`cukii-timeline-item cukii-timeline-event shrink-0 ${
                isLiveTurn && !lastInProgressToolCallId
                  ? "cukii-timeline-current"
                  : ""
              } ${isBeforeLatestSummary ? "opacity-50" : ""}`}
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
              className={`cukii-timeline-item shrink-0 ${getToolTimelineClass(
                toolCallState.status,
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

        // Turn-level "Interrupted" fact (Claude parity). Always shown when
        // the user canceled this turn, so the label is visible regardless of
        // whether an in-flight tool call already carries the per-tool label.
        // Render it as plain muted text, not a timeline event with a red dot.
        if (item.interrupted) {
          rows.push(
            <div
              key={`${message.id}-interrupted`}
              className={`cukii-interrupted-fact mt-2 min-w-0 ${
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
    latestSummaryIndex,
    sendInput,
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
        <DeprecationBanner dismissable={true} />
        {highlights}
        {history.length === 0 && (
          <EmptyChatBody showOnboardingCard={onboardingCard.show} />
        )}
        {renderTranscriptRows()}
        <InlineErrorMessage />
        {isStreaming && !isInEdit && (
          <div className="cukii-spinner-row" data-testid="cukii-spinner-row">
            <CukiiStreamingToolbar active={isStreaming} />
          </div>
        )}
      </StepsDiv>
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
    </>
  );
}
