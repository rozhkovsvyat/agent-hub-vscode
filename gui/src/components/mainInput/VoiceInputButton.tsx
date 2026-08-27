import { useEffect, useRef, useState } from "react";

type RecognitionResultEvent = Event & {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type RecognitionErrorEvent = Event & { error?: string };

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function getSpeechRecognition(): BrowserSpeechRecognitionConstructor | undefined {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
}

/** Native Chromium speech input used by the VS Code webview. */
export function VoiceInputButton({ onTranscript }: VoiceInputButtonProps) {
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = Boolean(getSpeechRecognition());

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    },
    [],
  );

  const stop = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  const start = () => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      setError("Voice input is unavailable in this VS Code build");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const finalText: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal && result[0]?.transcript) {
          finalText.push(result[0].transcript.trim());
        }
      }
      const transcript = finalText.filter(Boolean).join(" ");
      if (transcript) onTranscript(transcript);
    };
    recognition.onerror = (event) => {
      setError(
        event.error === "not-allowed"
          ? "Microphone permission is required"
          : "Voice input stopped",
      );
      setListening(false);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
    };

    setError(null);
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const title = error
    ? error
    : listening
      ? "Stop voice input"
      : "Start voice input";

  return (
    <button
      type="button"
      className="cukii-voice-button"
      aria-label="Voice dictation"
      aria-pressed={listening}
      title={title}
      disabled={!supported}
      onClick={() => (listening ? stop() : start())}
    >
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M10 2.75A2.75 2.75 0 0 0 7.25 5.5v4a2.75 2.75 0 0 0 5.5 0v-4A2.75 2.75 0 0 0 10 2.75Zm-4.75 6.5a.75.75 0 0 1 .75.75 4 4 0 0 0 8 0 .75.75 0 0 1 1.5 0 5.5 5.5 0 0 1-4.75 5.445v1.805h2a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1 0-1.5h2v-1.805A5.5 5.5 0 0 1 4.5 10a.75.75 0 0 1 .75-.75Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}
