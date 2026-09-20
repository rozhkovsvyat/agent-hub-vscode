import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CukiiIssueReportSubmission } from "core/protocol/ideWebview";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IdeMessengerProvider } from "../../context/IdeMessenger";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  ISSUE_SNAPSHOT_TIMEOUT_MS,
  ISSUE_SUBMIT_TIMEOUT_MS,
  ReportIssueModal,
} from "./ReportIssueModal";

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
  it("ignores the second press from a double-click that opened the form", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const { onClose } = renderForm();
    const dialog = screen.getByRole("dialog");
    const title = screen.getByPlaceholderText(
      "What happened? What did you do, and what did you expect instead?",
    );

    await screen.findByAltText("Sanitized Cukii chat preview");
    await screen.findByText(/1 sanitized diagnostic lines collected/i);
    expect(title).toHaveFocus();
    const footer = dialog.querySelector(".cukii-report-footer")!;
    expect(fireEvent.mouseDown(footer, { detail: 2 })).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(title).toHaveFocus();

    fireEvent.mouseDown(dialog, { detail: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps keyboard focus and restores the command trigger on close", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <IdeMessengerProvider messenger={messenger}>
          <button type="button" onClick={() => setOpen(true)}>
            Open report
          </button>
          <button type="button">Underlying composer</button>
          {open && (
            <ReportIssueModal
              sessionId="session-1"
              brokerModel="codex-5-6-terra"
              onClose={() => setOpen(false)}
            />
          )}
        </IdeMessengerProvider>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open report" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
      ),
    );
    expect(focusable.length).toBeGreaterThan(2);
    focusable.at(-1)?.focus();
    await user.tab();
    expect(document.activeElement).toBe(focusable[0]);
    focusable[0].focus();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(focusable.at(-1));

    await user.click(
      screen.getByRole("button", { name: "Close issue report" }),
    );
    expect(trigger).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Underlying composer" }),
    ).not.toHaveFocus();
  });

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
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      "Picker overlaps the composer",
    );
    expect(sessionStorage.length).toBe(0);
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Report" }));

    await screen.findByText("Report sent");
    expect(captureSnapshot).toHaveBeenCalledTimes(2);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      description: "Picker overlaps the composer",
      sessionId: "session-1",
      brokerModel: "codex-5-6-terra",
      snapshot: {
        pngBase64: SNAPSHOT.pngBase64,
        width: 640,
        height: 480,
        sanitizer: "cukii-report-v1",
      },
    });
    expect(submissions[0]).not.toHaveProperty("title");
    expect(submissions[0]).not.toHaveProperty("stepsToReproduce");
    expect(submissions[0]).not.toHaveProperty("expectedResult");
    expect(submissions[0]).not.toHaveProperty("actualResult");
  });

  it("lets the user remove the automatic snapshot from the report", async () => {
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
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      "The snapshot shows a private window",
    );
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledTimes(1));

    await user.click(
      screen.getByRole("button", { name: "Remove chat snapshot" }),
    );
    expect(screen.getByText("Snapshot excluded")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Report" }));
    await screen.findByText("Report sent");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).not.toHaveProperty("snapshot");
  });

  it("restores the automatic snapshot when the user re-includes it", async () => {
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
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      "Include the snapshot after all",
    );
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledTimes(1));

    await user.click(
      screen.getByRole("button", { name: "Remove chat snapshot" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Include chat snapshot" }),
    );
    await waitFor(() => expect(captureSnapshot).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Report" }));
    await screen.findByText("Report sent");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      snapshot: { pngBase64: SNAPSHOT.pngBase64, width: 640, height: 480 },
    });
  });

  it("collects a single description field plus severity, no section fields", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    renderForm();

    expect(
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Severity")).toBeInTheDocument();
    expect(screen.queryByText("Steps to reproduce")).not.toBeInTheDocument();
    expect(screen.queryByText("Expected result")).not.toBeInTheDocument();
    expect(screen.queryByText("Actual result")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/short description/i)).toBeNull();
  });

  it("accepts screenshots pasted from the clipboard without opening Explorer", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    const register = vi.fn(async (_request: { images: unknown[] }) => [
      {
        id: "clipboard-1",
        name: "clipboard-1.png",
        size: 4,
        mimeType: "image/png" as const,
        previewDataUrl: "data:image/png;base64,cG5n",
      },
    ]);
    (messenger.responseHandlers as Record<string, unknown>)[
      "cukii/registerIssueClipboardImages"
    ] = register;
    renderForm(messenger);
    await screen.findByAltText("Sanitized Cukii chat preview");

    const file = new File(["png"], "clipboard.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("dialog"), {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    expect(await screen.findByAltText("clipboard-1.png")).toBeInTheDocument();
    expect(register).toHaveBeenCalledOnce();
    expect(register.mock.calls.at(0)?.[0]).toMatchObject({
      images: [{ name: "clipboard.png", mimeType: "image/png" }],
    });
  });

  it("releases clipboard images that arrive after the form was closed", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    let resolveRegister: ((images: any[]) => void) | undefined;
    const register = vi.fn(
      () =>
        new Promise<any[]>((resolve) => {
          resolveRegister = resolve;
        }),
    );
    const release = vi.fn();
    (messenger.responseHandlers as Record<string, unknown>)[
      "cukii/registerIssueClipboardImages"
    ] = register;
    (messenger.responseHandlers as Record<string, unknown>)[
      "cukii/releaseIssueImages"
    ] = release;
    const rendered = renderForm(messenger);
    await screen.findByAltText("Sanitized Cukii chat preview");

    const file = new File(["png"], "late.png", { type: "image/png" });
    fireEvent.paste(screen.getByRole("dialog"), {
      clipboardData: {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });
    await waitFor(() => expect(register).toHaveBeenCalledOnce());
    cleanup();
    await act(async () => {
      resolveRegister?.([
        {
          id: "late-1",
          name: "late.png",
          size: 4,
          mimeType: "image/png",
          previewDataUrl: "data:image/png;base64,cG5n",
        },
      ]);
      await Promise.resolve();
    });

    expect(release).toHaveBeenCalledWith({ attachmentIds: ["late-1"] });
    expect(rendered.onClose).not.toHaveBeenCalled();
  });

  it("offers a clickable YouGile link after a sent report", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    const post = vi.spyOn(messenger, "post");
    messenger.responses["cukii/submitIssueReport"] = {
      reportId: "linked-report",
      status: "sent",
      taskId: "task-1",
      taskUrl: "https://yougile.com/team/132d36e8a8ce/#ID-207",
      message: "Report sent to the Cukii Bugs board.",
    } as (typeof messenger.responses)["cukii/submitIssueReport"];
    const { user } = renderForm(messenger);
    await user.type(
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      "Clickable result",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Report" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Report" }));

    await user.click(
      await screen.findByRole("button", { name: "Open report in YouGile" }),
    );
    expect(post).toHaveBeenCalledWith(
      "openUrl",
      "https://yougile.com/team/132d36e8a8ce/#ID-207",
    );
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
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      "YouGile returned 502",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Report" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Report" }));

    await screen.findByText("Report queued");
    expect(screen.getByText(/stored locally/i)).toBeInTheDocument();
  });

  it("unlocks a submission that never receives an extension-host response", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    const submissions: CukiiIssueReportSubmission[] = [];
    messenger.responseHandlers["cukii/submitIssueReport"] = (input) => {
      submissions.push(input);
      if (submissions.length === 1) return new Promise(() => undefined);
      return Promise.resolve({
        reportId: input.reportId,
        status: "sent" as const,
        taskId: "task-after-timeout",
        message: "Report sent to the Cukii Bugs board.",
      });
    };
    renderForm(messenger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Report" })).toBeDisabled(),
    );

    fireEvent.change(
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      { target: { value: "Extension host stopped replying" } },
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Report" })).toBeEnabled(),
    );

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Report" }));
      await act(async () => {
        await vi.runAllTicks();
      });
      expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ISSUE_SUBMIT_TIMEOUT_MS);
      });

      expect(screen.getByText(/submission timed out/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Report" })).toBeEnabled();
      expect(
        screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Close issue report" }),
      ).toBeEnabled();

      fireEvent.click(screen.getByRole("button", { name: "Report" }));
      await act(async () => {
        await vi.runAllTicks();
      });

      expect(screen.getByText("Report sent")).toBeInTheDocument();
      expect(submissions).toHaveLength(2);
      expect(submissions[1]).toEqual(submissions[0]);
      expect(captureSnapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("unlocks snapshot reconstruction when the initial capture never resolves", async () => {
    captureSnapshot.mockImplementationOnce(() => new Promise(() => undefined));
    vi.useFakeTimers();
    try {
      renderForm();
      expect(screen.getByText("Reconstructing…")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ISSUE_SNAPSHOT_TIMEOUT_MS);
      });

      expect(screen.getByText(/snapshot timed out/i)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Reconstruct chat snapshot" }),
      ).toBeEnabled();
      expect(screen.getByText("Unavailable")).toBeInTheDocument();

      captureSnapshot.mockResolvedValueOnce(SNAPSHOT);
      fireEvent.click(
        screen.getByRole("button", { name: "Reconstruct chat snapshot" }),
      );
      await act(async () => {
        await vi.runAllTicks();
      });
      expect(
        screen.getByAltText("Sanitized Cukii chat preview"),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unlocks report retry when the submit-time snapshot never resolves", async () => {
    captureSnapshot.mockResolvedValueOnce(SNAPSHOT);
    renderForm();
    await screen.findByAltText("Sanitized Cukii chat preview");
    fireEvent.change(
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      { target: { value: "Snapshot refresh stopped replying" } },
    );
    captureSnapshot.mockImplementationOnce(() => new Promise(() => undefined));

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Report" }));
      await act(async () => {
        await vi.runAllTicks();
      });
      expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ISSUE_SNAPSHOT_TIMEOUT_MS);
      });

      expect(screen.getByText(/snapshot timed out/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Report" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Reconstruct chat snapshot" }),
      ).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send when the sanitized DOM snapshot cannot be reconstructed", async () => {
    captureSnapshot.mockRejectedValue(new Error("Canvas unavailable"));
    const messenger = new MockIdeMessenger();
    const submit = vi.fn();
    messenger.responseHandlers["cukii/submitIssueReport"] = submit;
    const { user } = renderForm(messenger);

    await user.type(
      screen.getByPlaceholderText(
        "What happened? What did you do, and what did you expect instead?",
      ),
      "Snapshot failed",
    );
    await screen.findByText("Canvas unavailable");
    expect(screen.getByRole("button", { name: "Report" })).toBeDisabled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("states that the complete refreshed diagnostic set is attached", async () => {
    captureSnapshot.mockResolvedValue(SNAPSHOT);
    const messenger = new MockIdeMessenger();
    messenger.responses["cukii/prepareIssueReport"] = {
      extensionVersion: "2.0.110",
      operatingSystem: "Mock OS",
      remote: "ssh-remote",
      workspace: ["mock-workspace"],
      sessionId: "session-1",
      brokerModel: "codex-5-6-terra",
      logLines: Array.from({ length: 37 }, (_, index) => `event-${index}`),
    };
    renderForm(messenger);

    expect(
      await screen.findByText(/37 sanitized diagnostic lines collected/i),
    ).toHaveTextContent(/attaches the full set as cukii-diagnostics\.txt/i);
    expect(screen.getByText(/event-36/)).toBeInTheDocument();
  });
});
