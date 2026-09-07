import {
  ArrowPathIcon,
  BugAntIcon,
  PaperClipIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type {
  BrokerModel,
  CukiiIssueDiagnosticsPreview,
  CukiiIssuePickedImage,
  CukiiIssueReportReceipt,
  CukiiIssueSeverity,
} from "core/protocol/ideWebview";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import {
  captureCukiiChatSnapshot,
  type CukiiChatSnapshot,
} from "./captureChatSnapshot";

type ReportIssueModalProps = {
  sessionId: string;
  brokerModel: BrokerModel;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement>;
};

type IssueDraft = {
  title: string;
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
  severity: CukiiIssueSeverity;
};

type SubmitPhase = "idle" | "submitting" | "complete";

const EMPTY_DRAFT: IssueDraft = {
  title: "",
  stepsToReproduce: "",
  expectedResult: "",
  actualResult: "",
  severity: "major",
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function readableBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ReportIssueModal({
  sessionId,
  brokerModel,
  onClose,
  returnFocusRef,
}: ReportIssueModalProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  // Report text can itself contain secrets. Keep the draft only in component
  // memory; the extension-host sanitizes it before the first durable write.
  const [draft, setDraft] = useState<IssueDraft>({ ...EMPTY_DRAFT });
  const [attachments, setAttachments] = useState<CukiiIssuePickedImage[]>([]);
  const [diagnostics, setDiagnostics] =
    useState<CukiiIssueDiagnosticsPreview>();
  const [snapshot, setSnapshot] = useState<CukiiChatSnapshot>();
  const [snapshotBusy, setSnapshotBusy] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [receipt, setReceipt] = useState<CukiiIssueReportReceipt>();
  const reportIdRef = useRef(crypto.randomUUID());
  const submittingRef = useRef(false);
  const attachmentsRef = useRef<CukiiIssuePickedImage[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const resultCloseRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  attachmentsRef.current = attachments;

  const refreshSnapshot = useCallback(async () => {
    setSnapshotBusy(true);
    setSnapshotError(undefined);
    try {
      const next = await captureCukiiChatSnapshot();
      setSnapshot(next);
      return next;
    } catch (error) {
      setSnapshot(undefined);
      setSnapshotError(errorMessage(error));
      return undefined;
    } finally {
      setSnapshotBusy(false);
    }
  }, []);

  useEffect(() => {
    void refreshSnapshot();
    void ideMessenger
      .request("cukii/prepareIssueReport", { sessionId, brokerModel })
      .then((response) => {
        if (response.status === "success") setDiagnostics(response.content);
      });
  }, [brokerModel, ideMessenger, refreshSnapshot, sessionId]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    titleRef.current?.focus();
    return () => {
      const target = returnFocusRef?.current ?? previousFocusRef.current;
      if (target?.isConnected) target.focus();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    if (phase === "complete") resultCloseRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && phase !== "submitting") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (active === last || !dialog.contains(active))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, phase]);

  useEffect(
    () => () => {
      const attachmentIds = attachmentsRef.current.map(({ id }) => id);
      if (attachmentIds.length > 0) {
        void ideMessenger.request("cukii/releaseIssueImages", {
          attachmentIds,
        });
      }
    },
    [ideMessenger],
  );

  const updateDraft = <Key extends keyof IssueDraft>(
    key: Key,
    value: IssueDraft[Key],
  ) => setDraft((current) => ({ ...current, [key]: value }));

  const close = () => {
    if (phase !== "submitting") onClose();
  };

  const pickImages = async () => {
    setAttachmentError(undefined);
    const response = await ideMessenger.request("cukii/pickIssueImages", {
      remaining: 3 - attachments.length,
    });
    if (response.status === "error") {
      setAttachmentError(response.error);
      return;
    }
    setAttachments((current) => [...current, ...response.content].slice(0, 3));
  };

  const removeImage = (id: string) => {
    setAttachments((current) => current.filter((image) => image.id !== id));
    void ideMessenger.request("cukii/releaseIssueImages", {
      attachmentIds: [id],
    });
  };

  const submit = async () => {
    if (!draft.title.trim() || submittingRef.current) return;
    submittingRef.current = true;
    setPhase("submitting");
    setSubmitError(undefined);
    try {
      const currentSnapshot = await refreshSnapshot();
      if (!currentSnapshot) {
        throw new Error(
          "Cukii could not reconstruct the sanitized chat snapshot. Try again.",
        );
      }
      const response = await ideMessenger.request("cukii/submitIssueReport", {
        reportId: reportIdRef.current,
        ...draft,
        sessionId,
        brokerModel,
        attachmentIds: attachments.map(({ id }) => id),
        snapshot: {
          pngBase64: currentSnapshot.pngBase64,
          width: currentSnapshot.width,
          height: currentSnapshot.height,
          sanitizer: "cukii-report-v1",
        },
      });
      if (response.status === "error") throw new Error(response.error);
      attachmentsRef.current = [];
      setAttachments([]);
      setReceipt(response.content);
      setPhase("complete");
    } catch (error) {
      setSubmitError(errorMessage(error));
      setPhase("idle");
    } finally {
      submittingRef.current = false;
    }
  };

  return (
    <div
      className="cukii-report-overlay fixed inset-0 z-[100002] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cukii-report-title"
      onMouseDown={close}
    >
      <section
        ref={dialogRef}
        className="cukii-report-dialog flex flex-col overflow-hidden rounded-lg"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="cukii-report-header flex shrink-0 items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <BugAntIcon
              aria-hidden="true"
              className="h-[18px] w-[18px] shrink-0"
            />
            <h2 id="cukii-report-title" className="m-0 truncate">
              Report an issue
            </h2>
          </div>
          <button
            type="button"
            className="cukii-report-icon-button"
            aria-label="Close issue report"
            title="Close"
            disabled={phase === "submitting"}
            onClick={close}
          >
            <XMarkIcon />
          </button>
        </header>

        {phase === "complete" && receipt ? (
          <div className="cukii-report-result">
            <div className="cukii-report-result-mark" aria-hidden="true">
              ✓
            </div>
            <h3>
              {receipt.status === "sent" ? "Report sent" : "Report queued"}
            </h3>
            <p>{receipt.message}</p>
            {receipt.status === "queued" && (
              <p className="cukii-report-muted">
                The report and its files are stored locally. Cukii will retry
                automatically without creating a duplicate card.
              </p>
            )}
            <button
              ref={resultCloseRef}
              type="button"
              className="cukii-report-primary"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        ) : (
          <>
            <div className="cukii-report-body">
              <p className="cukii-report-intro">
                Describe what happened. Cukii adds a sanitized view of this chat
                and diagnostic logs automatically.
              </p>

              <label className="cukii-report-field">
                <span>
                  Title <strong aria-hidden="true">*</strong>
                </span>
                <input
                  ref={titleRef}
                  value={draft.title}
                  maxLength={160}
                  disabled={phase === "submitting"}
                  placeholder="A short description of the problem"
                  onChange={(event) => updateDraft("title", event.target.value)}
                />
              </label>

              <div className="cukii-report-grid">
                <label className="cukii-report-field">
                  <span>Severity</span>
                  <select
                    value={draft.severity}
                    disabled={phase === "submitting"}
                    onChange={(event) =>
                      updateDraft(
                        "severity",
                        event.target.value as CukiiIssueSeverity,
                      )
                    }
                  >
                    <option value="blocker">Blocker</option>
                    <option value="major">Major</option>
                    <option value="minor">Minor</option>
                    <option value="cosmetic">Cosmetic</option>
                  </select>
                </label>
              </div>

              {(
                [
                  [
                    "stepsToReproduce",
                    "Steps to reproduce",
                    "What did you do before the problem appeared?",
                  ],
                  [
                    "expectedResult",
                    "Expected result",
                    "What should have happened?",
                  ],
                  ["actualResult", "Actual result", "What happened instead?"],
                ] as const
              ).map(([key, label, placeholder]) => (
                <label key={key} className="cukii-report-field">
                  <span>{label}</span>
                  <textarea
                    value={draft[key]}
                    maxLength={4000}
                    rows={2}
                    disabled={phase === "submitting"}
                    placeholder={placeholder}
                    onChange={(event) => updateDraft(key, event.target.value)}
                  />
                </label>
              ))}

              <section
                className="cukii-report-assets"
                aria-label="Report attachments"
              >
                <div className="cukii-report-assets-heading">
                  <div>
                    <strong>Screenshots</strong>
                    <span>Up to 3 images, 5 MB each</span>
                  </div>
                  <button
                    type="button"
                    className="cukii-report-secondary"
                    disabled={phase === "submitting" || attachments.length >= 3}
                    onClick={() => void pickImages()}
                  >
                    <PaperClipIcon aria-hidden="true" />
                    Attach images…
                  </button>
                </div>

                <div className="cukii-report-previews">
                  <article className="cukii-report-preview-card">
                    <div className="cukii-report-preview-image">
                      {snapshot ? (
                        <img
                          src={snapshot.dataUrl}
                          alt="Sanitized Cukii chat preview"
                        />
                      ) : (
                        <span>
                          {snapshotBusy ? "Reconstructing…" : "Unavailable"}
                        </span>
                      )}
                    </div>
                    <div className="cukii-report-preview-caption">
                      <span>Automatic chat snapshot</span>
                      <button
                        type="button"
                        className="cukii-report-icon-button"
                        aria-label="Reconstruct chat snapshot"
                        title="Reconstruct snapshot"
                        disabled={snapshotBusy || phase === "submitting"}
                        onClick={() => void refreshSnapshot()}
                      >
                        <ArrowPathIcon
                          className={snapshotBusy ? "animate-spin" : ""}
                        />
                      </button>
                    </div>
                  </article>

                  {attachments.map((image) => (
                    <article
                      key={image.id}
                      className="cukii-report-preview-card"
                    >
                      <div className="cukii-report-preview-image">
                        <img src={image.previewDataUrl} alt={image.name} />
                      </div>
                      <div className="cukii-report-preview-caption">
                        <span title={image.name}>
                          {image.name} · {readableBytes(image.size)}
                        </span>
                        <button
                          type="button"
                          className="cukii-report-icon-button"
                          aria-label={`Remove ${image.name}`}
                          title="Remove"
                          disabled={phase === "submitting"}
                          onClick={() => removeImage(image.id)}
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </article>
                  ))}
                </div>

                {snapshotError && (
                  <p className="cukii-report-error" role="alert">
                    {snapshotError}
                  </p>
                )}
                {attachmentError && (
                  <p className="cukii-report-error" role="alert">
                    {attachmentError}
                  </p>
                )}
              </section>

              <details className="cukii-report-diagnostics">
                <summary>Automatic diagnostics</summary>
                {diagnostics ? (
                  <div>
                    <dl>
                      <dt>Cukii</dt>
                      <dd>{diagnostics.extensionVersion}</dd>
                      <dt>OS</dt>
                      <dd>{diagnostics.operatingSystem}</dd>
                      <dt>Remote</dt>
                      <dd>{diagnostics.remote || "local"}</dd>
                      <dt>Model</dt>
                      <dd>{diagnostics.brokerModel}</dd>
                      <dt>Session</dt>
                      <dd>{diagnostics.sessionId}</dd>
                    </dl>
                    <pre>{diagnostics.logLines.join("\n")}</pre>
                  </div>
                ) : (
                  <p>Collecting sanitized logs…</p>
                )}
              </details>

              {submitError && (
                <p className="cukii-report-error" role="alert">
                  {submitError}
                </p>
              )}
            </div>

            <footer className="cukii-report-footer">
              <span className="cukii-report-muted">
                Secrets and absolute local paths are masked before upload.
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="cukii-report-secondary"
                  disabled={phase === "submitting"}
                  onClick={close}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="cukii-report-primary"
                  disabled={
                    phase === "submitting" ||
                    !draft.title.trim() ||
                    snapshotBusy ||
                    !snapshot
                  }
                  onClick={() => void submit()}
                >
                  {phase === "submitting" ? "Sending…" : "Send report"}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
