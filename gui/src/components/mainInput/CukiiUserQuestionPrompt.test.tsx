import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { CukiiUserQuestionPrompt } from "./CukiiUserQuestionPrompt";

const request = (sessionId: string) => ({
  runId: "run-a",
  requestId: "question-a",
  sessionId,
  requestFingerprint: "a".repeat(64),
  questions: [
    {
      id: "deploy",
      header: "Deploy",
      question: "Where should this be deployed?",
      options: [
        { label: "Stage", description: "Use staging." },
        { label: "Production", description: "Use production." },
      ],
    },
  ],
});

describe("CukiiUserQuestionPrompt", () => {
  it("renders one vendor-agnostic sheet and returns the selected answer", async () => {
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    const { store, user } = await renderWithProviders(
      <CukiiUserQuestionPrompt />,
      { mockIdeMessenger: messenger },
    );
    await act(async () => {
      messenger.mockMessageToWebview(
        "cukii/userQuestionRequested",
        request(store.getState().session.id),
      );
    });
    const dialog = await screen.findByRole("dialog", { name: "User question" });
    expect(dialog).toBeDefined();
    expect(dialog.className).toContain("cukii-user-question");
    expect(dialog.className).not.toMatch(/fixed|bottom-5|right-5/);
    expect(screen.getByText("Where should this be deployed?")).toBeDefined();
    await user.click(screen.getByLabelText(/Production/));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(post).toHaveBeenCalledWith("cukii/respondUserQuestion", {
      runId: "run-a",
      requestId: "question-a",
      sessionId: store.getState().session.id,
      requestFingerprint: "a".repeat(64),
      answers: { deploy: "Production" },
    });
  });

  it("adds a free-form Other answer and requires non-empty text", async () => {
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    const { store, user } = await renderWithProviders(
      <CukiiUserQuestionPrompt />,
      { mockIdeMessenger: messenger },
    );
    await act(async () => {
      messenger.mockMessageToWebview(
        "cukii/userQuestionRequested",
        request(store.getState().session.id),
      );
    });
    await user.click(await screen.findByLabelText(/Other/));
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await user.type(screen.getByLabelText("Deploy other answer"), "Canary");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(post).toHaveBeenCalledWith(
      "cukii/respondUserQuestion",
      expect.objectContaining({ answers: { deploy: "Canary" } }),
    );
  });

  it("cancels a delayed wrong-session request instead of showing it", async () => {
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    await renderWithProviders(<CukiiUserQuestionPrompt />, {
      mockIdeMessenger: messenger,
    });
    await act(async () => {
      messenger.mockMessageToWebview(
        "cukii/userQuestionRequested",
        request("another-session"),
      );
    });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "cukii/respondUserQuestion",
        expect.objectContaining({
          sessionId: "another-session",
          cancelled: true,
        }),
      ),
    );
    expect(screen.queryByRole("dialog", { name: "User question" })).toBeNull();
  });

  it("cancels the exact request on Escape", async () => {
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    const { store, user } = await renderWithProviders(
      <CukiiUserQuestionPrompt />,
      { mockIdeMessenger: messenger },
    );
    await act(async () => {
      messenger.mockMessageToWebview(
        "cukii/userQuestionRequested",
        request(store.getState().session.id),
      );
    });
    await screen.findByRole("dialog", { name: "User question" });
    await user.keyboard("{Escape}");
    expect(post).toHaveBeenCalledWith(
      "cukii/respondUserQuestion",
      expect.objectContaining({ requestId: "question-a", cancelled: true }),
    );
  });

  it("drops the sheet when the broker withdraws the question", async () => {
    const messenger = new MockIdeMessenger();
    const { store } = await renderWithProviders(<CukiiUserQuestionPrompt />, {
      mockIdeMessenger: messenger,
    });
    await act(async () => {
      messenger.mockMessageToWebview(
        "cukii/userQuestionRequested",
        request(store.getState().session.id),
      );
    });
    await screen.findByRole("dialog", { name: "User question" });
    await act(async () => {
      messenger.mockMessageToWebview("cukii/userQuestionWithdrawn", {
        runId: "run-a",
        requestId: "question-a",
        sessionId: store.getState().session.id,
      });
    });
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "User question" })).toBeNull(),
    );
  });
});
