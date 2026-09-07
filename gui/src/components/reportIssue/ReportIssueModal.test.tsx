import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CukiiIssueReportSubmission } from "core/protocol/ideWebview";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { ReportIssueModal } from "./ReportIssueModal";

const captureSnapshot = vi.hoisted(() => vi.fn());

vi.mock("./captureChatSnapshot", () => ({
  captureCukiiChatSnapshot: captureSnapshot,
}));

const SNAPSHOT = {
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  pngBase64: "iVBORw0KGgo=",
  width: 640,
  height: 480,
  byteLength: 8,
};

afterEach(() => {
  cleanup();
  captureSnapshot.mockReset();
  sessionStorage.clear();
});

function renderForm(messenger = new MockIdeMessenger()) {
  const onClose = vi.fn();
  render(
    <IdeMessengerProvider messenger={messenger}>
      <ReportIssueModal
        sessionId="session-1"
        brokerModel="codex-5-6-terra"
        onClose={onClose}
      />
    </IdeMessengerProvider>,
  );
  return { messenger, onClose, user: userEvent.setup() };
}

describe("ReportIssueModal", () => {
  it("submits the form with a freshly reconstructed sanitized snapshot", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    const submissions: CukiiIssueReportSubmission[] = [];
    messenger.responseHandlers["cukii/submitIssueReport"] = async (input) => {
      submissions.push(input);
      return {
        reportId: input.reportId,
        status: "sent",
        taskId: "task-1",
        message: "Report sent to the Cukii Bugs board.",
      };
    };
    const { user } = renderForm(messenger);

    await user.type(
      screen.getByPlaceholderText("A short description of the problem"),
      "Picker overlaps the composer",
    );
    expect(sessionStorage.length).toBe(0);
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await screen.findByText("Report sent");
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      title: "Picker overlaps the composer",
      sessionId: "session-1",
      brokerModel: "codex-5-6-terra",
      snapshot: {
        pngBase64: SNAPSHOT.pngBase64,
        width: 640,
        height: 480,
        sanitizer: "cukii-report-v1",
      },
    });
  });

  it("shows an honest queued result when YouGile is temporarily unavailable", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    messenger.responses["cukii/submitIssueReport"] = {
      reportId: "report-queued",
      status: "queued",
      message: "Saved locally. Cukii will retry delivery automatically.",
    };
    const { user } = renderForm(messenger);

    await user.type(
      screen.getByPlaceholderText("A short description of the problem"),
      "YouGile returned 502",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send report" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Send report" }));

    await screen.findByText("Report queued");
    expect(screen.getByText(/stored locally/i)).toBeInTheDocument();
  });

  it("does not send when the sanitized DOM snapshot cannot be reconstructed", async () => {
    captureSnapshot.mockRejectedValue(new Error("Canvas unavailable"));
    const messenger = new MockIdeMessenger();
    const submit = vi.fn();
    messenger.responseHandlers["cukii/submitIssueReport"] = submit;
    const { user } = renderForm(messenger);

    await user.type(
      screen.getByPlaceholderText("A short description of the problem"),
      "Snapshot failed",
    );
    await screen.findByText("Canvas unavailable");
    expect(screen.getByRole("button", { name: "Send report" })).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();
  });
});
