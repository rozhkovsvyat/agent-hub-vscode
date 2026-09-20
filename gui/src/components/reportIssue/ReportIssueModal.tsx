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
  CukiiIssueReportSubmission,
  CukiiIssueSeverity,
} from "core/protocol/ideWebview";
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
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
  description: string;
  severity: CukiiIssueSeverity;
};

type SubmitPhase = "idle" | "submitting" | "complete";

export const ISSUE_SNAPSHOT_TIMEOUT_MS = 15_000;
export const ISSUE_SUBMIT_TIMEOUT_MS = 45_000;

export async function withIssueReportTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const EMPTY_DRAFT: IssueDraft = {
  description: "",
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

async function clipboardImage(file: File) {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error("The clipboard image could not be read."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("The clipboard image could not be read."));
    reader.readAsDataURL(file);
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    name: file.name || `clipboard-${Date.now()}.png`,
    mimeType: file.type as
      | "image/png"
      | "image/jpeg"
      | "image/webp"
      | "image/gif",
    base64,
  };
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
  const [snapshotExcluded, setSnapshotExcluded] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(true);
  const [snapshotError, setSnapshotError] = useState<string>();
  const [attachmentError, setAttachmentError] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [receipt, setReceipt] = useState<CukiiIssueReportReceipt>();
  const reportIdRef = useRef(crypto.randomUUID());
  const submissionRef = useRef<CukiiIssueReportSubmission>();
  const submittingRef = useRef(false);
  const snapshotGenerationRef = useRef(0);
  const attachmentsRef = useRef<CukiiIssuePickedImage[]>([]);
  const mountedRef = useRef(true);
  const pasteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const resultCloseRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const openedAtRef = useRef(Date.now());

  attachmentsRef.current = attachments;

  const refreshSnapshot = useCallback(async () => {
    const generation = ++snapshotGenerationRef.current;
    setSnapshotBusy(true);
    setSnapshotError(undefined);
    try {
      const next = await withIssueReportTimeout(
        captureCukiiChatSnapshot(),
        ISSUE_SNAPSHOT_TIMEOUT_MS,
        "Chat snapshot timed out. The form is unlocked; try again.",
      );
      if (generation !== snapshotGenerationRef.current) return undefined;
      setSnapshot(next);
      return next;
    } catch (error) {
      if (generation !== snapshotGenerationRef.current) return undefined;
      setSnapshotError(errorMessage(error));
      return undefined;
    } finally {
      if (generation === snapshotGenerationRef.current) {
        setSnapshotBusy(false);
      }
    }
  }, []);

  useEffect(
    () => () => {
      snapshotGenerationRef.current += 1;
    },
    [],
  );

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
    descriptionRef.current?.focus();
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
      mountedRef.current = false;
      const attachmentIds = attachmentsRef.current.map(({ id }) => id);
      attachmentsRef.current = [];
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

  const closeFromBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    // A double-click on the command-menu item mounts the dialog between the
    // first and second press. That second press lands on the new backdrop and
    // must not immediately close the form or steal focus from its first field.
    if (event.detail > 1) {
      event.preventDefault();
      return;
    }
    close();
  };

  const suppressOpeningDoubleClick = (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (event.detail > 1 && Date.now() - openedAtRef.current < 500) {
      // The second press may land anywhere in the newly mounted dialog (the
      // footer occupies the command item's old screen coordinates). Prevent
      // its default focus transfer, but keep ordinary later double-click text
      // selection intact.
      event.preventDefault();
    }
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
    acceptRegisteredImages(response.content);
  };

  const releaseImages = (images: CukiiIssuePickedImage[]) => {
    if (images.length === 0) return;
    void ideMessenger.request("cukii/releaseIssueImages", {
      attachmentIds: images.map(({ id }) => id),
    });
  };

  const acceptRegisteredImages = (images: CukiiIssuePickedImage[]) => {
    if (!mountedRef.current) {
      releaseImages(images);
      return;
    }
    const remaining = Math.max(0, 3 - attachmentsRef.current.length);
    const accepted = images.slice(0, remaining);
    const overflow = images.slice(remaining);
    const next = [...attachmentsRef.current, ...accepted];
    attachmentsRef.current = next;
    setAttachments(next);
    releaseImages(overflow);
  };

  const pasteImages = (event: ReactClipboardEvent<HTMLDivElement>) => {
    if (phase === "submitting" || submissionLocked) return;
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))
      .slice(0, 3);
    if (files.length === 0) return;
    event.preventDefault();
    setAttachmentError(undefined);
    const run = async () => {
      const remaining = Math.max(0, 3 - attachmentsRef.current.length);
      if (remaining === 0 || !mountedRef.current) return;
      try {
        const images = await Promise.all(
          files.slice(0, remaining).map(clipboardImage),
        );
        const response = await ideMessenger.request(
          "cukii/registerIssueClipboardImages",
          { images },
        );
        if (response.status === "error") throw new Error(response.error);
        acceptRegisteredImages(response.content);
      } catch (error) {
        if (mountedRef.current) setAttachmentError(errorMessage(error));
      }
    };
    pasteQueueRef.current = pasteQueueRef.current.then(run, run);
  };

  const removeImage = (id: string) => {
    const next = attachmentsRef.current.filter((image) => image.id !== id);
    attachmentsRef.current = next;
    setAttachments(next);
    void ideMessenger.request("cukii/releaseIssueImages", {
      attachmentIds: [id],
    });
  };

  const submit = async () => {
    if (!draft.description.trim() || submittingRef.current) return;
    submittingRef.current = true;
    setPhase("submitting");
    setSubmitError(undefined);
    try {
      let submission = submissionRef.current;
      if (!submission) {
        let snapshotPayload: CukiiIssueReportSubmission["snapshot"];
        if (!snapshotExcluded) {
          const currentSnapshot = await refreshSnapshot();
          if (!currentSnapshot) {
            throw new Error(
              "Cukii could not reconstruct the sanitized chat snapshot. Try again.",
            );
          }
          snapshotPayload = {
            pngBase64: currentSnapshot.pngBase64,
            width: currentSnapshot.width,
            height: currentSnapshot.height,
            sanitizer: "cukii-report-v1",
          };
        }
        submission = {
          reportId: reportIdRef.current,
          ...draft,
          sessionId,
          brokerModel,
          attachmentIds: attachments.map(({ id }) => id),
          ...(snapshotPayload ? { snapshot: snapshotPayload } : {}),
        };
        submissionRef.current = submission;
      }
      const response = await withIssueReportTimeout(
        ideMessenger.request("cukii/submitIssueReport", submission),
        ISSUE_SUBMIT_TIMEOUT_MS,
        "Report submission timed out. Retry is enabled and resends the original captured report with the same report ID; fields remain locked to prevent duplicates.",
      );
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

  const submissionLocked = Boolean(submissionRef.current);

  return (
    <div
      className="cukii-report-overlay fixed inset-0 z-[100002] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cukii-report-title"
      onMouseDownCapture={suppressOpeningDoubleClick}
      onMouseDown={closeFromBackdrop}
      onPaste={(event) => void pasteImages(event)}
      onClick={(event) => {
        // ReportIssueModal is rendered inside the main InputBoxDiv. React
        // bubbles clicks through that component tree even though this is a
        // full-screen modal; the parent click schedules TipTap.focus() on the
        // next frame. Keep every field/select/button interaction inside the
        // modal so the underlying composer cannot steal focus.
        event.stopPropagation();
      }}
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
            {receipt.taskUrl && (
              <button
                type="button"
                className="cukii-report-secondary"
                onClick={() => ideMessenger.post("openUrl", receipt.taskUrl!)}
              >
                Open report in YouGile
              </button>
            )}
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
                  Description <strong aria-hidden="true">*</strong>
                </span>
                <textarea
                  ref={descriptionRef}
                  value={draft.description}
                  maxLength={4000}
                  rows={8}
                  disabled={phase === "submitting" || submissionLocked}
                  placeholder="What happened? What did you do, and what did you expect instead?"
                  onChange={(event) =>
                    updateDraft("description", event.target.value)
                  }
                />
              </label>

              <div className="cukii-report-grid">
                <label className="cukii-report-field">
                  <span>Severity</span>
                  <select
                    value={draft.severity}
                    disabled={phase === "submitting" || submissionLocked}
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

              <section
                className="cukii-report-assets"
                aria-label="Report attachments"
              >
                <div className="cukii-report-assets-heading">
                  <div>
                    <strong>Screenshots</strong>
                    <span>Up to 3 images, 5 MB each · paste supported</span>
                  </div>
                  <button
                    type="button"
                    className="cukii-report-secondary"
                    disabled={
                      phase === "submitting" ||
                      submissionLocked ||
                      attachments.length >= 3
                    }
                    onClick={() => void pickImages()}
                  >
                    <PaperClipIcon aria-hidden="true" />
                    Attach images…
                  </button>
                </div>

                <div className="cukii-report-previews">
                  <article className="cukii-report-preview-card">
                    <div className="cukii-report-preview-image">
                      {snapshot && !snapshotExcluded ? (
                        <img
                          src={snapshot.dataUrl}
                          alt="Sanitized Cukii chat preview"
                        />
                      ) : (
                        <span>
                          {snapshotExcluded
                            ? "Excluded"
                            : snapshotBusy
                              ? "Reconstructing…"
                              : "Unavailable"}
                        </span>
                      )}
                    </div>
                    <div className="cukii-report-preview-caption">
                      <span>
                        {snapshotExcluded
                          ? "Snapshot excluded"
                          : "Automatic chat snapshot"}
                      </span>
                      {snapshotExcluded ? (
                        <button
                          type="button"
                          className="cukii-report-icon-button"
                          aria-label="Include chat snapshot"
                          title="Include snapshot"
                          disabled={phase === "submitting" || submissionLocked}
                          onClick={() => {
                            setSnapshotExcluded(false);
                            void refreshSnapshot();
                          }}
                        >
                          <ArrowPathIcon />
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="cukii-report-icon-button"
                            aria-label="Remove chat snapshot"
                            title="Do not send the snapshot"
                            disabled={
                              phase === "submitting" || submissionLocked
                            }
                            onClick={() => setSnapshotExcluded(true)}
                          >
                            <TrashIcon />
                          </button>
                          <button
                            type="button"
                            className="cukii-report-icon-button"
                            aria-label="Reconstruct chat snapshot"
                            title="Reconstruct snapshot"
                            disabled={
                              snapshotBusy ||
                              phase === "submitting" ||
                              submissionLocked
                            }
                            onClick={() => void refreshSnapshot()}
                          >
                            <ArrowPathIcon
                              className={snapshotBusy ? "animate-spin" : ""}
                            />
                          </button>
                        </>
                      )}
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
                          disabled={phase === "submitting" || submissionLocked}
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
                    <p className="cukii-report-muted">
                      {diagnostics.logLines.length} sanitized diagnostic lines
                      collected. Cukii refreshes them at send time and attaches
                      the full set as cukii-diagnostics.txt.
                    </p>
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
                    !draft.description.trim() ||
                    (!snapshotExcluded && (snapshotBusy || !snapshot))
                  }
                  onClick={() => void submit()}
                >
                  {phase === "submitting" ? "Sending…" : "Report"}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
