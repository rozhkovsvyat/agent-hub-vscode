import type {
  CukiiUserQuestionRequest,
  CukiiUserQuestionResponse,
} from "core/protocol/ideWebview";
import {
  FormEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  enqueueUserQuestion,
  removeUserQuestion,
} from "../../redux/slices/sessionSlice";

function responseBase(request: CukiiUserQuestionRequest) {
  return {
    runId: request.runId,
    requestId: request.requestId,
    sessionId: request.sessionId,
    requestFingerprint: request.requestFingerprint,
  };
}

/** One consistent question sheet for every vendor connected to Cukii MCP. */
export function CukiiUserQuestionPrompt() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const sessionId = useAppSelector((state) => state.session.id);
  const pending = useAppSelector((state) => state.session.pendingUserQuestions);
  const request = Object.values(pending)[0];
  const pendingRef = useRef(pending);
  const firstOptionRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  pendingRef.current = pending;

  useEffect(() => {
    setSelected({});
    setOther({});
    queueMicrotask(() => firstOptionRef.current?.focus());
  }, [request?.runId, request?.requestId]);

  const answers = useMemo(() => {
    if (!request) return undefined;
    const result: Record<string, string> = {};
    for (const question of request.questions) {
      const choice = selected[question.id];
      const answer =
        choice === "__other__" ? other[question.id]?.trim() : choice;
      if (!answer) return undefined;
      result[question.id] = answer;
    }
    return result;
  }, [other, request, selected]);

  const respond = (
    item: CukiiUserQuestionRequest,
    response: Partial<Pick<CukiiUserQuestionResponse, "answers" | "cancelled">>,
  ) => {
    ideMessenger.post("cukii/respondUserQuestion", {
      ...responseBase(item),
      ...response,
    });
    dispatch(
      removeUserQuestion({ runId: item.runId, requestId: item.requestId }),
    );
  };

  useWebviewListener(
    "cukii/userQuestionRequested",
    async (item) => {
      if (item.sessionId !== sessionId) {
        ideMessenger.post("cukii/respondUserQuestion", {
          ...responseBase(item),
          cancelled: true,
        });
        return { accepted: false };
      }
      dispatch(enqueueUserQuestion(item));
      return { accepted: true };
    },
    [dispatch, ideMessenger, sessionId],
  );

  useEffect(() => {
    return () => {
      for (const item of Object.values(pendingRef.current)) {
        ideMessenger.post("cukii/respondUserQuestion", {
          ...responseBase(item),
          cancelled: true,
        });
      }
    };
  }, [ideMessenger]);

  if (!request) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (answers) respond(request, { answers });
  };

  return (
    <form
      aria-label="User question"
      aria-modal="true"
      className="cukii-user-question fixed bottom-5 right-5 z-[2001] w-[min(460px,calc(100vw-2rem))]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          respond(request, { cancelled: true });
        }
      }}
      onSubmit={submit}
      role="dialog"
    >
      <div className="cukii-user-question-title">Cukii needs your input</div>
      <div className="cukii-user-question-list">
        {request.questions.map((question, questionIndex) => (
          <fieldset key={question.id}>
            <legend>
              <span>{question.header}</span>
              <strong>{question.question}</strong>
            </legend>
            {question.options.map((option, optionIndex) => (
              <label key={option.label} className="cukii-user-question-option">
                <input
                  checked={selected[question.id] === option.label}
                  name={`cukii-question-${question.id}`}
                  onChange={() =>
                    setSelected((current) => ({
                      ...current,
                      [question.id]: option.label,
                    }))
                  }
                  ref={
                    questionIndex === 0 && optionIndex === 0
                      ? firstOptionRef
                      : undefined
                  }
                  type="radio"
                  value={option.label}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
            <label className="cukii-user-question-option">
              <input
                checked={selected[question.id] === "__other__"}
                name={`cukii-question-${question.id}`}
                onChange={() =>
                  setSelected((current) => ({
                    ...current,
                    [question.id]: "__other__",
                  }))
                }
                type="radio"
                value="__other__"
              />
              <span>
                <strong>Other</strong>
                <small>Enter a different answer.</small>
              </span>
            </label>
            {selected[question.id] === "__other__" && (
              <input
                aria-label={`${question.header} other answer`}
                autoFocus
                className="cukii-user-question-other"
                maxLength={4096}
                onChange={(event) =>
                  setOther((current) => ({
                    ...current,
                    [question.id]: event.target.value,
                  }))
                }
                value={other[question.id] ?? ""}
              />
            )}
          </fieldset>
        ))}
      </div>
      <div className="cukii-user-question-actions">
        <button
          type="button"
          onClick={() => respond(request, { cancelled: true })}
        >
          Cancel
        </button>
        <button disabled={!answers} type="submit">
          Submit
        </button>
      </div>
    </form>
  );
}
