import { fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { VoiceInputButton } from "./VoiceInputButton";

class FakeTrack {
  stop = vi.fn();
  getSettings = () => ({ sampleRate: 48_000 });
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event & { error?: Error }) => void) | null = null;
  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    FakeRecorder.instances.push(this);
  }
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["voice-bytes"], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.();
  });
}

function installMicrophone(getUserMedia = vi.fn(async () => fakeStream())) {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return getUserMedia;
}

function fakeStream() {
  const track = new FakeTrack();
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeRecorder.instances = [];
});

describe("VoiceInputButton", () => {
  it("captures once in the webview and sends non-empty MediaRecorder bytes to the host", async () => {
    installMicrophone();
    const onTranscript = vi.fn();
    const { getByRole, ideMessenger } = await renderWithProviders(
      <VoiceInputButton onTranscript={onTranscript} />,
    );
    const requestSpy = vi.spyOn(ideMessenger, "request");
    const button = getByRole("button", { name: "Voice dictation" });

    fireEvent.click(button);
    await waitFor(() =>
      expect(button.getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("привет Куки"),
    );

    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(requestSpy).toHaveBeenCalledWith(
      "cukii/transcribeVoiceRecording",
      expect.objectContaining({
        recordingId: expect.any(String),
        audioBase64: expect.any(String),
        mimeType: "audio/webm;codecs=opus",
        sampleRate: 48_000,
      }),
    );
    // Regression control: old code asked the host to start/stop a competing
    // DirectShow recorder, which was the source of the duplicate terminal toast.
    expect(requestSpy).not.toHaveBeenCalledWith(
      "cukii/startVoiceRecording",
      expect.anything(),
    );
    expect(requestSpy).not.toHaveBeenCalledWith(
      "cukii/stopVoiceRecording",
      expect.anything(),
    );
  });

  it("maps denied permission to one actionable retry state", async () => {
    const denied = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    installMicrophone(vi.fn(async () => Promise.reject(denied)));
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );

    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() =>
      expect(
        rendered.getByRole("button", {
          name: /Voice dictation failed: Microphone permission was denied/,
        }),
      ).toHaveClass("cukii-voice-button-error"),
    );
  });

  it("ignores a stale transcription response after the webview unmounts", async () => {
    installMicrophone();
    let resolve!: (value: { text: string }) => void;
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/transcribeVoiceRecording"] =
      async () =>
        new Promise((done) => {
          resolve = done;
        });
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() =>
      expect(button.getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.click(button);
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    rendered.unmount();
    resolve({ text: "late text" });
    await Promise.resolve();
  });
});
