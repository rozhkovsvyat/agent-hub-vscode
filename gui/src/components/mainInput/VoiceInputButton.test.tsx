import { fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceInputButton } from "./VoiceInputButton";

class SpeechRecognitionMock {
  static latest: SpeechRecognitionMock | null = null;
  continuous = false;
  interimResults = true;
  lang = "";
  onresult: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();

  constructor() {
    SpeechRecognitionMock.latest = this;
  }
}

describe("VoiceInputButton", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "SpeechRecognition");
    SpeechRecognitionMock.latest = null;
  });

  it("starts native speech recognition, emits final text and stops", () => {
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: SpeechRecognitionMock,
    });
    const onTranscript = vi.fn();
    const { getByRole } = render(
      <VoiceInputButton onTranscript={onTranscript} />,
    );

    const button = getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);

    const recognition = SpeechRecognitionMock.latest;
    expect(recognition?.start).toHaveBeenCalledOnce();
    expect(button.getAttribute("aria-pressed")).toBe("true");

    recognition?.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "  привет Куки  " } }],
    });
    expect(onTranscript).toHaveBeenCalledWith("привет Куки");

    fireEvent.click(button);
    expect(recognition?.stop).toHaveBeenCalledOnce();
  });
});
