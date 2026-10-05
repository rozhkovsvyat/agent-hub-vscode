import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { VoiceInputButton } from "./VoiceInputButton";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe("VoiceInputButton native host lifecycle", () => {
  it("starts once, exposes listening ARIA, stops once and inserts host transcript", async () => {
    const onTranscript = vi.fn();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={onTranscript} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async ({ recordingId }) => ({ recordingId, device: "Steinberg" });
    const spy = vi.spyOn(rendered.ideMessenger, "request");
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(
      spy.mock.calls.filter(([route]) => route === "cukii/startVoiceRecording"),
    ).toHaveLength(1);
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("привет Куки"),
    );
    expect(
      spy.mock.calls.filter(([route]) => route === "cukii/stopVoiceRecording"),
    ).toHaveLength(1);
    expect(button).toHaveAttribute("aria-busy", "false");
  });

  it("cancels a pending start on unmount and ignores its stale success", async () => {
    const start = deferred<{ recordingId: string; device: string }>();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] = () =>
      start.promise;
    const spy = vi.spyOn(rendered.ideMessenger, "request");
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() =>
      expect(rendered.getByRole("button")).toHaveAttribute("aria-busy", "true"),
    );
    const requestedId = (
      spy.mock.calls.find(
        ([route]) => route === "cukii/startVoiceRecording",
      )?.[1] as { recordingId: string }
    ).recordingId;
    rendered.unmount();
    start.resolve({ recordingId: requestedId, device: "Steinberg" });
    await waitFor(() =>
      expect(
        spy.mock.calls.filter(
          ([route]) => route === "cukii/cancelVoiceRecording",
        ).length,
      ).toBeGreaterThanOrEqual(1),
    );
  });

  it("does not insert a stop reply after unmount", async () => {
    const stop = deferred<{ text: string }>();
    const onTranscript = vi.fn();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={onTranscript} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async ({ recordingId }) => ({ recordingId, device: "Steinberg" });
    rendered.ideMessenger.responseHandlers["cukii/stopVoiceRecording"] = () =>
      stop.promise;
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button);
    rendered.unmount();
    stop.resolve({ text: "stale transcript" });
    await Promise.resolve();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("cancels ownership and rejects a transcript from the previous session", async () => {
    const stop = deferred<{ text: string }>();
    const onTranscript = vi.fn();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={onTranscript} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async ({ recordingId }) => ({ recordingId, device: "Steinberg" });
    rendered.ideMessenger.responseHandlers["cukii/stopVoiceRecording"] = () =>
      stop.promise;
    const spy = vi.spyOn(rendered.ideMessenger, "request");
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button);
    await act(async () => {
      rendered.store.dispatch({ type: "session/newSession" });
    });
    stop.resolve({ text: "belongs to old session" });
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([route]) => route === "cukii/cancelVoiceRecording",
        ),
      ).toBe(true),
    );
    expect(onTranscript).not.toHaveBeenCalled();
    expect(button).toHaveAttribute("aria-busy", "false");
  });

  it("returns to retryable error state when host start fails", async () => {
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async () => {
        throw new Error("Steinberg unavailable");
      };
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() =>
      expect(rendered.getByRole("button").getAttribute("aria-label")).toContain(
        "Steinberg unavailable",
      ),
    );
    expect(rendered.getByRole("button")).not.toBeDisabled();
    expect(rendered.getByRole("button")).toHaveAttribute("aria-busy", "false");
  });

  it("transcribes what was said when the host hits the five-minute limit", async () => {
    // Card 364dbc2f: the limit used to end in an error and lose the audio.
    const onTranscript = vi.fn();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={onTranscript} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async ({ recordingId }) => ({ recordingId, device: "Steinberg" });
    rendered.ideMessenger.responseHandlers["cukii/voiceRecordingStatus"] =
      async () => ({ state: "expired", message: "Recording expired" });
    const stops: string[] = [];
    rendered.ideMessenger.responseHandlers["cukii/stopVoiceRecording"] =
      async ({ recordingId }) => {
        stops.push(recordingId);
        return { text: "до лимита" };
      };
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("до лимита"), {
      timeout: 1_500,
    });
    expect(stops).toHaveLength(1);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).not.toBeDisabled();
  });

  it("shows a running recording timer, a stop square and a discard control", async () => {
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async ({ recordingId }) => ({ recordingId, device: "Steinberg" });
    const spy = vi.spyOn(rendered.ideMessenger, "request");
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    const status = rendered.getByTestId("cukii-voice-status");
    expect(status).toHaveTextContent(/Recording 0:0\d/);
    expect(status).toHaveTextContent("/ 5:00");
    expect(rendered.getByTestId("cukii-voice-stop-glyph")).toBeTruthy();

    fireEvent.click(
      rendered.getByRole("button", { name: "Discard voice recording" }),
    );
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(rendered.queryByTestId("cukii-voice-status")).toBeNull();
    expect(
      spy.mock.calls.filter(([route]) => route === "cukii/cancelVoiceRecording"),
    ).toHaveLength(1);
    expect(
      spy.mock.calls.filter(([route]) => route === "cukii/stopVoiceRecording"),
    ).toHaveLength(0);
  });

  it("says it is transcribing while the host works after Stop", async () => {
    const stop = deferred<{ text: string }>();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async ({ recordingId }) => ({ recordingId, device: "Steinberg" });
    rendered.ideMessenger.responseHandlers["cukii/stopVoiceRecording"] = () =>
      stop.promise;
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button);
    await waitFor(() =>
      expect(rendered.getByTestId("cukii-voice-status")).toHaveTextContent(
        /Transcribing… 0:0\d/,
      ),
    );
    expect(button).toHaveAttribute("aria-busy", "true");
    await act(async () => stop.resolve({ text: "готово" }));
    await waitFor(() =>
      expect(rendered.queryByTestId("cukii-voice-status")).toBeNull(),
    );
  });

  it("offers Retry on the kept recording after a failed transcription", async () => {
    const onTranscript = vi.fn();
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={onTranscript} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async ({ recordingId }) => ({ recordingId, device: "Steinberg" });
    let kept = false;
    const stops: string[] = [];
    rendered.ideMessenger.responseHandlers["cukii/stopVoiceRecording"] =
      async ({ recordingId }) => {
        stops.push(recordingId);
        if (stops.length === 1) {
          kept = true;
          throw new Error("Recognition failed. The recording is kept.");
        }
        kept = false;
        return { text: "со второй попытки" };
      };
    rendered.ideMessenger.responseHandlers["cukii/voiceRecordingStatus"] =
      async () => ({ state: kept ? "kept" : "unknown" });
    const button = rendered.getByRole("button", { name: "Voice dictation" });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(button);
    const retry = await rendered.findByRole("button", { name: "Retry" });
    expect(button.getAttribute("aria-label")).toContain("Recognition failed");

    fireEvent.click(retry);
    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("со второй попытки"),
    );
    expect(stops).toHaveLength(2);
    expect(new Set(stops).size).toBe(1);
    expect(rendered.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
