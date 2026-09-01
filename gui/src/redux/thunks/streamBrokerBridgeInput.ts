import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ChatMessage, PromptLog } from "core";
import { renderChatMessage } from "core/util/messageContent";
import {
  acceptToolCall,
  addPromptCompletionPair,
  abortStream,
  errorToolCall,
  markSteerRead,
  markLatestUserReceiptDelivered,
  setActive,
  setBridgeWait,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setSteerStatus,
  setToolCallCalling,
  streamUpdate,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { RootState, ThunkApiType } from "../store";

type CukiiBridgeMessage = ChatMessage & {
  cukiiBridgeWait?: {
    condition: string;
    deadline?: string;
  };
  cukiiTerminalError?: true;
  /** Private transport receipt emitted only for a matching vendor user echo. */
  cukiiSteerReadMessageId?: string;
  /** First factual stdout from the native CLI, never a local launch status. */
  cukiiVendorActivity?: true;
};

type RaceResult<T> =
  | { kind: "value"; value: IteratorResult<T, PromptLog | undefined> }
  | { kind: "cancelled" };

function isBridgeTerminalMessage(message: ChatMessage): boolean {
  return (
    (message as ChatMessage & { cukiiTerminal?: true }).cukiiTerminal === true
  );
}

function isBridgeTerminalError(message: ChatMessage): boolean {
  return (message as CukiiBridgeMessage).cukiiTerminalError === true;
}

/**
 * Native CLIs can repeat a failed-turn receipt as assistant text, a decorated
 * warning, or one concatenated frame.  Compare the message semantics rather
 * than a vendor's wording or a particular quota error.
 */
export function normalizeTerminalError(message: ChatMessage): string {
  return renderChatMessage(message)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:(?:⚠️|warning|error)\s*[:：\-–—]?\s*)+/iu, "")
    .trim();
}

function isOneOrMoreCopies(value: string, unit: string): boolean {
  if (!value || !unit) return false;

  let remainder = value;
  do {
    if (!remainder.startsWith(unit)) return false;
    remainder = remainder.slice(unit.length).trimStart();
  } while (remainder);

  return true;
}

export function isSameTerminalError(
  first: ChatMessage,
  second: ChatMessage,
): boolean {
  const normalizedFirst = normalizeTerminalError(first);
  const normalizedSecond = normalizeTerminalError(second);
  return (
    normalizedFirst === normalizedSecond ||
    isOneOrMoreCopies(normalizedFirst, normalizedSecond) ||
    isOneOrMoreCopies(normalizedSecond, normalizedFirst)
  );
}

/**
 * Позволяет выйти из await gen.next(), если стрим отменили (кнопка Stop / Esc).
 * Без этого GUI мог застрять в ожидании зависшего нативного worker-а и не сбросить
 * isStreaming — лоадер продолжал крутиться после остановки сессии.
 */
function raceNextOrCancellation<T>(
  nextPromise: Promise<IteratorResult<T, PromptLog | undefined>>,
  getState: () => RootState,
): Promise<RaceResult<T>> {
  return Promise.race([
    nextPromise.then((value) => ({ kind: "value" as const, value })),
    new Promise<RaceResult<T>>((resolve) => {
      const check = () => {
        if (!getState().session.isStreaming) {
          resolve({ kind: "cancelled" as const });
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    }),
  ]);
}

/**
 * Инструменты, которые пришли из моста, УЖЕ выполнены нативным worker-ом.
 *
 * Без этого их состояние осталось бы «сгенерирован», и лента предложила бы
 * запустить локально то, что уже сделано в чужом процессе. Поэтому tool-call
 * сразу переводится в done, а пришедший результат прикрепляется как вывод.
 */
function settleObservedToolCalls(
  messages: ChatMessage[],
  dispatch: (action: any) => void,
): void {
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      for (const call of message.toolCalls) {
        if (call.id) {
          // «Выполняется», а не сразу «готово»: результат придёт отдельным
          // событием, и до него карточка обязана показывать движение. Сразу
          // выставленный done выглядел как зависшая галочка.
          dispatch(setToolCallCalling({ toolCallId: call.id }));
        }
      }
    }
    if (message.role === "tool" && message.toolCallId) {
      dispatch(
        (message as ChatMessage & { cukiiToolError?: boolean }).cukiiToolError
          ? errorToolCall({ toolCallId: message.toolCallId })
          : acceptToolCall({ toolCallId: message.toolCallId }),
      );
      dispatch(
        updateToolCallOutput({
          toolCallId: message.toolCallId,
          contextItems: [
            {
              name: "Tool output",
              description: "Вывод инструмента нативного worker-а",
              content:
                typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
            },
          ],
        }),
      );
    }
  }
}

export const streamBrokerBridgeInput = createAsyncThunk<
  void,
  { queuedFollowUpMessageId?: string } | undefined,
  ThunkApiType
>(
  "chat/streamBrokerBridgeInput",
  async (options, { dispatch, extra, getState }) => {
    const state = getState();
    const sessionId = state.session.id;
    const queuedFollowUpMessageId = options?.queuedFollowUpMessageId;
    const brokerModel = state.session.brokerModel ?? "fable-5";
    const brokerSubagent = state.session.brokerSubagent ?? "auto";
    const brokerEffort = state.session.brokerEffort;
    const brokerSpeed = state.session.brokerSpeed;
    const thinkingEnabled = state.session.hasReasoningEnabled;
    const streamAborter = state.session.streamAborter;
    const initialUserReceiptId = queuedFollowUpMessageId
      ? undefined
      : state.session.history.findLast(
          (item) => item.message.role === "user" && !item.isSteer,
        )?.message.id;

    const queuedFollowUp = queuedFollowUpMessageId
      ? state.session.history.find(
          (item) => item.isSteer && item.message.id === queuedFollowUpMessageId,
        )
      : undefined;
    if (queuedFollowUpMessageId && !queuedFollowUp) {
      throw new Error(
        `Queued follow-up ${queuedFollowUpMessageId} is absent from session ${state.session.id}.`,
      );
    }
    const messages: ChatMessage[] = state.session.history
      // A model switch is a local timeline receipt. It must not become a
      // system turn in the next vendor request, even on the direct bridge path.
      .filter(
        (item) =>
          !item.modelSwitch &&
          item.message.id !== queuedFollowUpMessageId &&
          !(
            item.isSteer &&
            (item.steerStatus === "queued" ||
              item.steerStatus === "deferred" ||
              // An explicit Stop cancelled this follow-up before the vendor
              // accepted it. It must never reach a later turn either.
              item.steerStatus === "cancelled")
          ),
      )
      .map((item) => item.message)
      .filter((message) => message.role !== "thinking");
    if (queuedFollowUp) messages.push(queuedFollowUp.message);
    const historyLengthAtRunStart = state.session.history.length;
    const seenTerminalErrors = new Set<string>();
    let terminalSettled = false;

    const settleTerminal = () => {
      if (!terminalSettled && getState().session.id === sessionId) {
        terminalSettled = true;
        dispatch(setInactive());
      }
    };

    const markAcceptedAndPersist = async (messageId: string) => {
      const current = getState().session;
      if (current.id !== sessionId) return;
      const item = current.history.find(
        (entry) => entry.message.id === messageId,
      );
      if (item?.steerStatus === "read") return;
      if (
        item?.isSteer &&
        (item.steerStatus === "queued" || item.steerStatus === "deferred")
      ) {
        dispatch(setSteerStatus({ messageId, status: "delivered" }));
      }
      dispatch(markSteerRead({ messageId }));
      const { saveCurrentSession } = await import("./session");
      unwrapResult(
        await dispatch(
          saveCurrentSession({
            openNewSession: false,
            generateTitle: false,
          }),
        ),
      );
    };

    const isDuplicateTerminalError = (message: ChatMessage) => {
      const normalized = normalizeTerminalError(message);
      if (!normalized || seenTerminalErrors.has(normalized)) return true;

      const appearedThisRun = getState()
        .session.history.slice(historyLengthAtRunStart)
        .some(
          (item) =>
            item.message.role === "assistant" &&
            isSameTerminalError(item.message, message),
        );
      seenTerminalErrors.add(normalized);
      return appearedThisRun;
    };

    dispatch(setActive());
    dispatch(markLatestUserReceiptDelivered());
    dispatch(setInlineErrorMessage(undefined));
    dispatch(setIsPruned(false));
    dispatch(setContextPercentage(0));

    try {
      const gen = extra.ideMessenger.streamRequest(
        "cukii/streamBridgeChat",
        {
          sessionId: state.session.id,
          messages,
          brokerModel,
          brokerSubagent,
          brokerEffort,
          brokerSpeed,
          thinkingEnabled,
          brokerPermissionMode: state.session.brokerPermissionMode,
          queuedFollowUpMessageId,
        },
        streamAborter.signal,
      );

      let completed = false;
      try {
        while (true) {
          const result = await raceNextOrCancellation(gen.next(), getState);
          if (result.kind === "cancelled") {
            dispatch(abortStream());
            await gen.return(undefined);
            break;
          }
          if (result.value.done) {
            completed = true;
            if (result.value.value) {
              dispatch(addPromptCompletionPair([result.value.value]));
            }
            break;
          }
          if (getState().session.id !== sessionId) {
            await gen.return(undefined);
            break;
          }
          if (!getState().session.isStreaming) {
            dispatch(abortStream());
            await gen.return(undefined);
            break;
          }

          let hasTerminalReceipt = false;
          for (const message of result.value.value as CukiiBridgeMessage[]) {
            if (isBridgeTerminalMessage(message)) {
              hasTerminalReceipt = true;
              break;
            }
            if (message.cukiiSteerReadMessageId) {
              await markAcceptedAndPersist(message.cukiiSteerReadMessageId);
              continue;
            }
            if (isBridgeTerminalError(message)) {
              if (!isDuplicateTerminalError(message)) {
                dispatch(streamUpdate([message]));
              }
              hasTerminalReceipt = true;
              break;
            }
            if (message.cukiiBridgeWait) {
              // Positively identified native wait metadata, never a model string
              // and never an inference from quiet stdout.
              dispatch(setBridgeWait(message.cukiiBridgeWait));
              continue;
            }
            if (message.cukiiVendorActivity) {
              if (queuedFollowUpMessageId) {
                await markAcceptedAndPersist(queuedFollowUpMessageId);
              } else if (initialUserReceiptId) {
                dispatch(markSteerRead({ messageId: initialUserReceiptId }));
              }
            }
            dispatch(streamUpdate([message]));
            settleObservedToolCalls([message], dispatch);
          }
          if (hasTerminalReceipt) {
            // Hide activity synchronously on the native terminal receipt. The
            // generator return still performs process cleanup, but a slow child
            // close must never leave the user looking at a false loader.
            settleTerminal();
            completed = true;
            await gen.return(undefined);
            break;
          }
        }
      } finally {
        if (!completed) await gen.return(undefined);
      }
    } finally {
      settleTerminal();
    }
  },
);
