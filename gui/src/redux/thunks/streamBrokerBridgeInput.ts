import { createAsyncThunk } from "@reduxjs/toolkit";
import { ChatMessage, PromptLog } from "core";
import {
  acceptToolCall,
  addPromptCompletionPair,
  abortStream,
  errorToolCall,
  setActive,
  setBridgeWait,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
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
};

type RaceResult<T> =
  | { kind: "value"; value: IteratorResult<T, PromptLog | undefined> }
  | { kind: "cancelled" };

function isBridgeTerminalMessage(message: ChatMessage): boolean {
  return (
    (message as ChatMessage & { cukiiTerminal?: true }).cukiiTerminal === true
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
  void,
  ThunkApiType
>("chat/streamBrokerBridgeInput", async (_, { dispatch, extra, getState }) => {
  const state = getState();
  const brokerModel = state.session.brokerModel ?? "fable-5";
  const brokerSubagent = state.session.brokerSubagent ?? "auto";
  const brokerEffort = state.session.brokerEffort;
  const brokerSpeed = state.session.brokerSpeed;
  const thinkingEnabled = state.session.hasReasoningEnabled;
  const streamAborter = state.session.streamAborter;

  const messages: ChatMessage[] = state.session.history
    .map((item) => item.message)
    .filter((message) => message.role !== "thinking");

  dispatch(setActive());
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
        if (!getState().session.isStreaming) {
          dispatch(abortStream());
          await gen.return(undefined);
          break;
        }

        let hasTerminalReceipt = false;
        for (const message of result.value.value as CukiiBridgeMessage[]) {
          if (isBridgeTerminalMessage(message)) {
            hasTerminalReceipt = true;
            continue;
          }
          if (message.cukiiBridgeWait) {
            // Positively identified native wait metadata, never a model string
            // and never an inference from quiet stdout.
            dispatch(setBridgeWait(message.cukiiBridgeWait));
            continue;
          }
          dispatch(streamUpdate([message]));
          settleObservedToolCalls([message], dispatch);
        }
        if (hasTerminalReceipt) {
          // Hide activity synchronously on the native terminal receipt. The
          // generator return still performs process cleanup, but a slow child
          // close must never leave the user looking at a false loader.
          dispatch(setInactive());
          completed = true;
          await gen.return(undefined);
          break;
        }
      }
    } finally {
      if (!completed) await gen.return(undefined);
    }
  } finally {
    dispatch(setInactive());
  }
});
