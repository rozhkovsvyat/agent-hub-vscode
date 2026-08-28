import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../util/test/render";
import { VoiceInputButton } from "./VoiceInputButton";

describe("VoiceInputButton", () => {
  it("starts native recording, stops it and inserts the local transcript", async () => {
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
    expect(requestSpy).toHaveBeenCalledWith(
      "cukii/startVoiceRecording",
      expect.objectContaining({ recordingId: expect.any(String) }),
    );

    fireEvent.click(button);
    await waitFor(() =>
      expect(onTranscript).toHaveBeenCalledWith("привет Куки"),
    );
    expect(requestSpy).toHaveBeenCalledWith("cukii/stopVoiceRecording", {
      recordingId: "mock-recording",
    });
  });

  it("keeps a visible retry state when the native microphone fails", async () => {
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async () => {
        throw new Error("Microphone is busy");
      };

    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() =>
      expect(
        rendered.getByRole("button", {
          name: /Voice dictation failed: Microphone is busy\. Click to retry\./,
        }),
      ).toHaveClass("cukii-voice-button-error"),
    );
  });

  it("owns a pending start before awaiting it so unmount can cancel", async () => {
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    let requestedId = "";
    rendered.ideMessenger.responseHandlers["cukii/startVoiceRecording"] =
      async (data) => {
        requestedId = data.recordingId;
        return new Promise(() => undefined);
      };
    const requestSpy = vi.spyOn(rendered.ideMessenger, "request");
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(() => expect(requestedId).not.toBe(""));
    rendered.unmount();
    expect(requestSpy).toHaveBeenCalledWith("cukii/cancelVoiceRecording", {
      recordingId: requestedId,
    });
  });

  it("shows the duration-expiry terminal state reported by the extension", async () => {
    const rendered = await renderWithProviders(
      <VoiceInputButton onTranscript={vi.fn()} />,
    );
    rendered.ideMessenger.responseHandlers["cukii/voiceRecordingStatus"] =
      async () => ({
        state: "expired",
        message: "Voice recording reached the five-minute limit.",
      });
    fireEvent.click(rendered.getByRole("button", { name: "Voice dictation" }));
    await waitFor(
      () =>
        expect(
          rendered.getByRole("button", {
            name: /Voice dictation failed: Voice recording reached the five-minute limit/,
          }),
        ).toHaveClass("cukii-voice-button-error"),
      { timeout: 2_000 },
    );
  });
});
