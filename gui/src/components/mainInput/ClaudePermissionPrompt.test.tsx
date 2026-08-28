import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { renderWithProviders } from "../../util/test/render";
import { ClaudePermissionPrompt } from "./ClaudePermissionPrompt";

describe("ClaudePermissionPrompt", () => {
  it("shows the exact request and replies with a correlated allow decision", async () => {
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    const { user, store } = await renderWithProviders(
      <ClaudePermissionPrompt />,
      {
        mockIdeMessenger: messenger,
      },
    );
    messenger.mockMessageToWebview("cukii/claudePermissionRequested", {
      runId: "run-a",
      requestId: "request-a",
      sessionId: store.getState().session.id,
      inputFingerprint: "fingerprint-a",
      toolName: "Bash",
      input: { command: "git status" },
    });
    expect(
      await screen.findByLabelText("Claude permission request"),
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Allow" }));
    expect(post).toHaveBeenCalledWith("cukii/respondClaudePermission", {
      runId: "run-a",
      requestId: "request-a",
      sessionId: store.getState().session.id,
      inputFingerprint: "fingerprint-a",
      decision: "allow",
    });
  });

  it("denies a request delivered after this panel changed session", async () => {
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    await renderWithProviders(<ClaudePermissionPrompt />, {
      mockIdeMessenger: messenger,
    });
    messenger.mockMessageToWebview("cukii/claudePermissionRequested", {
      runId: "run-b",
      requestId: "request-b",
      sessionId: "another-session",
      inputFingerprint: "fingerprint-b",
      toolName: "Write",
      input: { path: "a.ts" },
    });
    await vi.waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "cukii/respondClaudePermission",
        expect.objectContaining({ runId: "run-b", decision: "deny" }),
      ),
    );
    expect(
      document.querySelector('[aria-label="Claude permission request"]'),
    ).toBeNull();
  });
});
