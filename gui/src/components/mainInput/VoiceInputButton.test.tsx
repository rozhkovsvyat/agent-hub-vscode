import { act, fireEvent, waitFor } from "@testing-library/react";
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
  static startError: Error | undefined;
  static lastOptions: MediaRecorderOptions | undefined;
  static nextChunk = new Blob(["voice-bytes"], {
    type: "audio/webm;codecs=opus",
  });
  state: RecordingState = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: Event & { error?: Error }) => void) | null = null;
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    FakeRecorder.lastOptions = options;
    FakeRecorder.instances.push(this);
  }
  start = vi.fn(() => {
    if (FakeRecorder.startError) throw FakeRecorder.startError;
    this.state = "recording";
  });
  stop = vi.fn(() => {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.ondataavailable?.({ data: FakeRecorder.nextChunk } as BlobEvent);
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
  FakeRecorder.startError = undefined;
  FakeRecorder.lastOptions = undefined;
  FakeRecorder.nextChunk = new Blob(["voice-bytes"], {
    type: "audio/webm;codecs=opus",
  });
  FakeRecorder.isTypeSupported.mockReturnValue(true);
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
    const payload = requestSpy.mock.calls[0][1] as {
      audioBase64: string;
    };
    expect(Buffer.from(payload.audioBase64, "base64").toString()).toBe(
      "voice-bytes",
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
    const onTranscript = vi.fn();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={onTranscript} />,
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
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("cleans up and exposes a retry when MediaRecorder.start throws", async () => {
    const stream = fakeStream();
    installMicrophone(vi.fn(async () => stream));
    FakeRecorder.startError = Object.assign(new Error("codec rejected"), {
      name: "NotSupportedError",
    });
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() =>
      expect(
        rendered.getByRole("button", {
          name: /Voice dictation failed: codec rejected/,
        }),
      ).toHaveAttribute("aria-busy", "false"),
    );
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
  });

  it("reserves acquisition before awaiting and stops a stale resolved stream", async () => {
    let resolve!: (stream: MediaStream) => void;
    const getUserMedia = installMicrophone(
      vi.fn(() => new Promise<MediaStream>((done) => (resolve = done))),
    );
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    const stream = fakeStream();
    rendered.unmount();
    resolve(stream);
    await waitFor(() => expect(stream.getTracks()[0].stop).toHaveBeenCalled());
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it("reports a zero-byte recording without crossing IPC", async () => {
    installMicrophone();
    FakeRecorder.nextChunk = new Blob([], { type: "audio/webm" });
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    const requestSpy = vi.spyOn(rendered.ideMessenger, "request");
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        rendered.getByRole("button", {
          name: /Voice dictation failed: No microphone audio was captured/,
        }),
      ).toBeEnabled(),
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("rejects an oversized Blob before base64 and IPC", async () => {
    installMicrophone();
    FakeRecorder.nextChunk = new Blob([new Uint8Array(8 * 1024 * 1024 + 1)], {
      type: "audio/webm",
    });
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    const requestSpy = vi.spyOn(rendered.ideMessenger, "request");
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        rendered.getByRole("button", {
          name: /Voice dictation failed: The microphone recording is too large/,
        }),
      ).toBeEnabled(),
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("turns recorder error plus stop into one terminal GUI error", async () => {
    installMicrophone();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    const requestSpy = vi.spyOn(rendered.ideMessenger, "request");
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    const recorder = FakeRecorder.instances[0];
    act(() => {
      recorder.onerror?.(
        Object.assign(new Event("error"), {
          error: new Error("capture failed"),
        }),
      );
      recorder.onstop?.();
    });
    await waitFor(() =>
      expect(
        rendered.getByRole("button", {
          name: /Voice dictation failed: capture failed/,
        }),
      ).toBeEnabled(),
    );
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("falls back to the browser-selected MIME when preferred codecs are unsupported", async () => {
    installMicrophone();
    FakeRecorder.isTypeSupported.mockReturnValue(false);
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() => expect(FakeRecorder.instances).toHaveLength(1));
    expect(FakeRecorder.lastOptions).toBeUndefined();
    rendered.unmount();
  });

  it.each([
    ["NotFoundError", /No microphone is available/],
    ["NotReadableError", /microphone is busy or unavailable/],
  ])("maps %s and keeps the button retryable", async (name, message) => {
    installMicrophone(
      vi.fn(async () =>
        Promise.reject(Object.assign(new Error(name), { name })),
      ),
    );
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() =>
      expect(
        rendered.getByRole("button", { name: message }),
      ).not.toBeDisabled(),
    );
  });

  it("fails honestly when webview capture APIs are missing", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("MediaRecorder", undefined);
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() =>
      expect(
        rendered.getByRole("button", {
          name: /Voice dictation failed: Voice input is not supported/,
        }),
      ).toBeEnabled(),
    );
  });
});
