import { useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
}

type VoiceState = "idle" | "starting" | "listening" | "transcribing";

type ActiveRecording = {
  recordingId: string;
  recorder: MediaRecorder;
  stream: MediaStream;
  chunks: Blob[];
  startedAt: number;
  timeout: number;
};

const MAX_RECORDING_MS = 5 * 60 * 1000;

function voiceErrorMessage(error: unknown): string {
  const name = (error as { name?: unknown })?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone permission was denied. Allow Cukii to use the microphone and retry.";
  if (name === "NotFoundError")
    return "No microphone is available. Connect or select a Windows recording device and retry.";
  if (name === "NotReadableError" || name === "AbortError")
    return "The microphone is busy or unavailable. Close the app using it and retry.";
  return error instanceof Error ? error.message : String(error);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read microphone audio."));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== "string" || !value.includes(","))
        return reject(new Error("Could not read microphone audio."));
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function stopTracks(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop());
}

function preferredRecorderOptions(): MediaRecorderOptions | undefined {
  const mimeType = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ].find(
    (candidate) =>
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported(candidate),
  );
  return mimeType ? { mimeType } : undefined;
}

/** Browser/webview is the only microphone owner; host only decodes/transcribes. */
export function VoiceInputButton({ onTranscript }: VoiceInputButtonProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const activeRecording = useRef<ActiveRecording>();
  const mounted = useRef(true);
  const [state, setState] = useState<VoiceState>("idle");
  const [error, setError] = useState<string>();

  const discard = (recording: ActiveRecording) => {
    window.clearTimeout(recording.timeout);
    stopTracks(recording.stream);
  };

  const fail = (recordingId: string, reason: unknown) => {
    const active = activeRecording.current;
    if (!active || active.recordingId !== recordingId) return;
    activeRecording.current = undefined;
    discard(active);
    if (!mounted.current) return;
    setError(voiceErrorMessage(reason));
    setState("idle");
  };

  const finish = async (recording: ActiveRecording) => {
    const { recordingId } = recording;
    if (activeRecording.current?.recordingId !== recordingId) return;
    window.clearTimeout(recording.timeout);
    stopTracks(recording.stream);
    const blob = new Blob(recording.chunks, {
      type: recording.recorder.mimeType || "audio/webm",
    });
    if (blob.size === 0)
      return fail(recordingId, new Error("No microphone audio was captured."));
    if (mounted.current) setState("transcribing");
    try {
      const audioBase64 = await blobToBase64(blob);
      if (activeRecording.current?.recordingId !== recordingId) return;
      const sampleRate = recording.stream
        .getAudioTracks()[0]
        ?.getSettings().sampleRate;
      const response = await ideMessenger.request(
        "cukii/transcribeVoiceRecording",
        {
          recordingId,
          audioBase64,
          mimeType: blob.type || "audio/webm",
          sampleRate,
          durationMs: Math.max(1, Date.now() - recording.startedAt),
        },
      );
      if (
        !mounted.current ||
        activeRecording.current?.recordingId !== recordingId
      )
        return;
      activeRecording.current = undefined;
      const text =
        response.status === "success" ? response.content.text.trim() : "";
      if (!text)
        setError(
          response.status === "error"
            ? response.error
            : "No speech was recognized.",
        );
      else {
        onTranscript(text);
        setError(undefined);
      }
      setState("idle");
    } catch (caught) {
      fail(recordingId, caught);
    }
  };

  useEffect(
    () => () => {
      mounted.current = false;
      const active = activeRecording.current;
      activeRecording.current = undefined;
      if (!active) return;
      window.clearTimeout(active.timeout);
      active.recorder.ondataavailable = null;
      active.recorder.onstop = null;
      active.recorder.onerror = null;
      if (active.recorder.state !== "inactive") active.recorder.stop();
      stopTracks(active.stream);
    },
    [],
  );

  const start = async () => {
    if (activeRecording.current) return;
    const recordingId =
      globalThis.crypto?.randomUUID?.() ??
      `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setError(undefined);
    setState("starting");
    let stream: MediaStream | undefined;
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "Voice input is not supported by this VS Code webview. Update VS Code and retry.",
        );
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!mounted.current || activeRecording.current) {
        stopTracks(stream);
        return;
      }
      const recorder = new MediaRecorder(stream, preferredRecorderOptions());
      const active: ActiveRecording = {
        recordingId,
        recorder,
        stream,
        chunks: [],
        startedAt: Date.now(),
        timeout: 0,
      };
      activeRecording.current = active;
      recorder.ondataavailable = (event) => {
        if (
          activeRecording.current?.recordingId === recordingId &&
          event.data.size > 0
        )
          active.chunks.push(event.data);
      };
      recorder.onerror = (event) =>
        fail(
          recordingId,
          (event as Event & { error?: Error }).error ??
            new Error("The microphone recorder failed."),
        );
      recorder.onstop = () => void finish(active);
      recorder.start(250);
      active.timeout = window.setTimeout(() => {
        if (
          activeRecording.current?.recordingId === recordingId &&
          recorder.state !== "inactive"
        )
          recorder.stop();
      }, MAX_RECORDING_MS);
      if (mounted.current) setState("listening");
    } catch (caught) {
      if (stream) stopTracks(stream);
      if (mounted.current && !activeRecording.current) {
        setError(voiceErrorMessage(caught));
        setState("idle");
      }
    }
  };

  const stop = () => {
    const active = activeRecording.current;
    if (!active || active.recorder.state === "inactive") return;
    setState("transcribing");
    active.recorder.stop();
  };

  const title = error
    ? error
    : state === "starting"
      ? "Requesting microphone…"
      : state === "listening"
        ? "Stop and transcribe"
        : state === "transcribing"
          ? "Transcribing locally…"
          : "Start voice input";

  return (
    <button
      type="button"
      className={`cukii-voice-button ${state === "listening" ? "cukii-voice-button-listening" : ""} ${error ? "cukii-voice-button-error" : ""}`}
      aria-label={
        error
          ? `Voice dictation failed: ${error}. Click to retry.`
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
