import { useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppSelector } from "../../redux/hooks";

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
}
type VoiceState = "idle" | "starting" | "listening" | "transcribing";
type Operation = {
  recordingId: string;
  sessionId: string;
  phase: "starting" | "listening" | "stopping";
};

/** The webview is control-plane only; native capture and ASR live in the host. */
export function VoiceInputButton({ onTranscript }: VoiceInputButtonProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const sessionId = useAppSelector((state) => state.session.id);
  const sessionIdRef = useRef(sessionId);
  const operation = useRef<Operation>();
  const cancelledIds = useRef(new Set<string>());
  const mounted = useRef(true);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string>();
  const cancel = (active?: Operation) => {
    if (!active || cancelledIds.current.has(active.recordingId)) return;
    cancelledIds.current.add(active.recordingId);
    void ideMessenger
      .request("cukii/cancelVoiceRecording", {
        recordingId: active.recordingId,
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    sessionIdRef.current = sessionId;
    const active = operation.current;
    if (active && active.sessionId !== sessionId) {
      operation.current = undefined;
      cancel(active);
      setState("idle");
      setError(undefined);
    }
  }, [sessionId]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const active = operation.current;
      operation.current = undefined;
      cancel(active);
    };
  }, [ideMessenger]);

  useEffect(() => {
    if (state !== "listening") return;
    const timer = window.setInterval(async () => {
      const active = operation.current;
      if (!active || active.phase !== "listening") return;
      try {
        const response = await ideMessenger.request(
          "cukii/voiceRecordingStatus",
          { recordingId: active.recordingId },
        );
        if (
          !mounted.current ||
          operation.current !== active ||
          response.status !== "success"
        )
          return;
        if (response.content.state !== "listening") {
          operation.current = undefined;
          cancel(active);
          setError(
            response.content.message ?? "Voice recording ended unexpectedly.",
          );
          setState("idle");
        }
      } catch {
        /* transient polling failure keeps recorder ownership */
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [ideMessenger, state]);

  const start = async () => {
    if (operation.current) return;
    const requestedId =
      globalThis.crypto?.randomUUID?.() ??
      `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const active: Operation = {
      recordingId: requestedId,
      sessionId: sessionIdRef.current,
      phase: "starting",
    };
    operation.current = active;
    setError(undefined);
    setState("starting");
    try {
      const response = await ideMessenger.request("cukii/startVoiceRecording", {
        recordingId: requestedId,
      });
      if (
        !mounted.current ||
        operation.current !== active ||
        active.sessionId !== sessionIdRef.current
      ) {
        if (response.status === "success") cancel(active);
        return;
      }
      if (response.status === "error") {
        operation.current = undefined;
        setError(response.error);
        setState("idle");
      } else if (response.content.recordingId !== requestedId) {
        operation.current = undefined;
        cancel({ ...active, recordingId: response.content.recordingId });
        setError("Voice recorder returned an unexpected recording identifier.");
        setState("idle");
      } else {
        active.phase = "listening";
        setState("listening");
      }
    } catch (caught) {
      if (mounted.current && operation.current === active) {
        operation.current = undefined;
        setError(caught instanceof Error ? caught.message : String(caught));
        setState("idle");
      }
    }
  };

  const stop = async () => {
    const active = operation.current;
    if (!active || active.phase !== "listening") return;
    active.phase = "stopping";
    setState("transcribing");
    try {
      const response = await ideMessenger.request("cukii/stopVoiceRecording", {
        recordingId: active.recordingId,
      });
      if (
        !mounted.current ||
        operation.current !== active ||
        active.sessionId !== sessionIdRef.current
      )
        return;
      operation.current = undefined;
      if (response.status === "success") {
        const text = response.content.text.trim();
        if (text) {
          onTranscript(text);
          setError(undefined);
        } else setError("No speech was recognized.");
      } else setError(response.error);
      setState("idle");
    } catch (caught) {
      if (mounted.current && operation.current === active) {
        operation.current = undefined;
        setError(caught instanceof Error ? caught.message : String(caught));
        setState("idle");
      }
    }
  };

  const title =
    error ??
    (state === "starting"
      ? "Starting microphone…"
      : state === "listening"
        ? "Stop and transcribe"
        : state === "transcribing"
          ? "Transcribing locally…"
          : "Start voice input");
  return (
    <button
      type="button"
      className={`cukii-voice-button ${state === "listening" ? "cukii-voice-button-listening" : ""} ${error ? "cukii-voice-button-error" : ""}`}
      aria-label={
        error
          ? `Voice dictation failed: ${error}. Click to retry.`
          : state === "listening"
            ? "Voice dictation listening; click to stop and transcribe"
            : "Voice dictation"
      }
      aria-pressed={state === "listening"}
      aria-busy={state === "starting" || state === "transcribing"}
      title={title}
      disabled={state === "starting" || state === "transcribing"}
      onClick={() => void (state === "listening" ? stop() : start())}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M10 2.75A2.75 2.75 0 0 0 7.25 5.5v4a2.75 2.75 0 0 0 5.5 0v-4A2.75 2.75 0 0 0 10 2.75Zm-4.75 6.5a.75.75 0 0 1 .75.75 4 4 0 0 0 8 0 .75.75 0 0 1 1.5 0 5.5 5.5 0 0 1-4.75 5.445v1.805h2a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5h2v-1.805A5.5 5.5 0 0 1 4.5 10a.75.75 0 0 1 .75-.75Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
