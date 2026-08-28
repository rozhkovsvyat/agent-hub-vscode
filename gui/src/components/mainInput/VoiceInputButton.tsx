import { useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
}

type VoiceState = "idle" | "starting" | "listening" | "transcribing";

/** Native FFmpeg capture + local multilingual Whisper in the extension host. */
export function VoiceInputButton({ onTranscript }: VoiceInputButtonProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const recordingId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string>();

  useEffect(
    () => () => {
      mounted.current = false;
      if (recordingId.current) {
        void ideMessenger.request("cukii/cancelVoiceRecording", {
          recordingId: recordingId.current,
        });
        recordingId.current = undefined;
      }
    },
    [ideMessenger],
  );

  useEffect(() => {
    if (state !== "listening" || !recordingId.current) return;
    const timer = window.setInterval(async () => {
      const active = recordingId.current;
      if (!active) return;
      try {
        const response = await ideMessenger.request(
          "cukii/voiceRecordingStatus",
          { recordingId: active },
        );
        if (!mounted.current || response.status !== "success") return;
        if (
          response.content.state === "expired" ||
          response.content.state === "error"
        ) {
          recordingId.current = undefined;
          setError(
            response.content.message ?? "Voice recording ended unexpectedly.",
          );
          setState("idle");
        }
      } catch {
        // The stop action reports the authoritative error; transient polling
        // failures must not discard ownership of an active microphone.
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [ideMessenger, state]);

  const start = async () => {
    const requestedId =
      globalThis.crypto?.randomUUID?.() ??
      `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    recordingId.current = requestedId;
    setError(undefined);
    setState("starting");
    try {
      const response = await ideMessenger.request(
        "cukii/startVoiceRecording",
        { recordingId: requestedId },
      );
      if (!mounted.current || recordingId.current !== requestedId) return;
      if (response.status === "error") {
        recordingId.current = undefined;
        setError(response.error);
        setState("idle");
        return;
      }
      recordingId.current = response.content.recordingId;
      setState("listening");
    } catch (caught) {
      if (!mounted.current || recordingId.current !== requestedId) return;
      recordingId.current = undefined;
      setError(caught instanceof Error ? caught.message : String(caught));
      setState("idle");
    }
  };

  const stop = async () => {
    const active = recordingId.current;
    if (!active) return;
    recordingId.current = undefined;
    setState("transcribing");
    try {
      const response = await ideMessenger.request("cukii/stopVoiceRecording", {
        recordingId: active,
      });
      if (response.status === "success") {
        onTranscript(response.content.text);
        setError(undefined);
      } else {
        setError(response.error);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    setState("idle");
  };

  const title = error
    ? error
    : state === "starting"
      ? "Starting microphone…"
      : state === "listening"
        ? "Stop and transcribe"
        : state === "transcribing"
          ? "Transcribing locally…"
          : "Start voice input";

  return (
    <button
      type="button"
      className={`cukii-voice-button ${state === "listening" ? "cukii-voice-button-listening" : ""} ${error ? "cukii-voice-button-error" : ""}`}
      aria-label={error ? `Voice dictation failed: ${error}. Click to retry.` : "Voice dictation"}
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
