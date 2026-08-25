import { createAsyncThunk } from "@reduxjs/toolkit";
import { ChatMessage, PromptLog } from "core";
import {
  acceptToolCall,
  addPromptCompletionPair,
  abortStream,
  errorToolCall,
  setActive,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setToolCallCalling,
  streamUpdate,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

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
        messages,
        brokerModel,
        brokerSubagent,
      },
      streamAborter.signal,
    );

    let next = await gen.next();
    while (!next.done) {
      if (!getState().session.isStreaming) {
        dispatch(abortStream());
        break;
      }

      dispatch(streamUpdate(next.value));
      settleObservedToolCalls(next.value, dispatch);
      next = await gen.next();
    }

    if (next.done && next.value) {
      dispatch(addPromptCompletionPair([next.value as PromptLog]));
    }
  } finally {
    dispatch(setInactive());
  }
});
