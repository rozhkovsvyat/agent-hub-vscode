import { maskCukiiReportText } from "core/cukiiReportMasking";
import type {
  BrokerModel,
  CukiiIssueDiagnosticsPreview,
  CukiiIssuePickedImage,
  CukiiIssueReportCapability,
  CukiiIssueReportReceipt,
  CukiiIssueReportSubmission,
  CukiiIssueSeverity,
} from "core/protocol/ideWebview";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ProtectedSecretStore } from "./alibabaTokenPlan";
import {
  recentCukiiDiagnostics,
  recordCukiiDiagnostic,
} from "./cukiiDiagnosticBuffer";
import {
  probeYougileKey,
  readYougileAccount,
  YOUGILE_API_BASE,
  type YougileEnvironment,
} from "./yougileAccount";

export const CUKII_BUGS_PROJECT_ID = "945711d1-c885-4c95-9b88-73a8647d0756";
export const CUKII_BUGS_BOARD_ID = "af617b56-a4a4-49fd-8afd-b2c3db1b0787";
export const CUKII_BUGS_INBOX_COLUMN_ID =
  "a00a7ee9-dd85-4053-8309-1e5ceb402a40";

export const CUKII_ISSUE_MAX_IMAGES = 3;
export const CUKII_ISSUE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const CUKII_ISSUE_MAX_TITLE = 160;
export const CUKII_ISSUE_MAX_FIELD = 4_000;
const ORPHAN_CLEANUP_RETRY_MS = 30_000;

type IssueResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
  headers?: { get(name: string): string | null };
};

export type YougileIssueHttp = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string | Buffer;
    signal?: AbortSignal;
  },
) => Promise<IssueResponse>;

export type YougileIssueReporterHost = {
  storageRoot: string;
  store: ProtectedSecretStore;
  environment?: YougileEnvironment;
  extensionVersion: string;
  vscodeVersion: string;
  operatingSystem: string;
  remote: () => string;
  workspace: () => string[];
  logRoot?: string;
  http?: YougileIssueHttp;
  now?: () => Date;
};

type LocalIssueFile = {
  kind: "snapshot" | "manual" | "diagnostics";
  name: string;
  mimeType: string;
  localName: string;
  remoteUrl?: string;
};

type StoredIssueReport = {
  schemaVersion: 1;
  reportId: string;
  createdAt: string;
  title: string;
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
  severity: CukiiIssueSeverity;
  sessionId: string;
  brokerModel: BrokerModel;
  files: LocalIssueFile[];
  taskId?: string;
  chatPosted?: boolean;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
};

type PickedImage = {
  path: string;
  name: string;
  size: number;
  mimeType: CukiiIssuePickedImage["mimeType"];
};

class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs = 30_000,
  ) {
    super(message);
  }
}

const IMAGE_MIME = new Map<string, CukiiIssuePickedImage["mimeType"]>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

const defaultHttp: YougileIssueHttp = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body as unknown as BodyInit,
    signal: init.signal,
  });

function content(value: unknown): unknown[] {
  return Array.isArray((value as { content?: unknown })?.content)
    ? ((value as { content: unknown[] }).content ?? [])
    : [];
}

function safeFileName(name: string): string {
  const cleaned = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.slice(0, 120) || "attachment";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function severityLabel(severity: CukiiIssueSeverity): string {
  return {
    blocker: "Blocker",
    major: "Major",
    minor: "Minor",
    cosmetic: "Cosmetic",
  }[severity];
}

function retryDelay(attempts: number): number {
  return [30_000, 120_000, 300_000, 900_000, 1_800_000][
    Math.min(Math.max(0, attempts - 1), 4)
  ];
}

async function atomicWrite(file: string, body: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, body);
  try {
    await fs.promises.rename(temporary, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await fs.promises.unlink(file).catch(() => undefined);
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.unlink(temporary).catch(() => undefined);
  }
}

async function tailFile(file: string, maxBytes: number): Promise<string> {
  const stat = await fs.promises.stat(file);
  const length = Math.min(stat.size, maxBytes);
  if (length <= 0) return "";
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function logFiles(root: string | undefined): Promise<string[]> {
  if (!root) return [];
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 2 || found.length >= 8) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= 8) break;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target, depth + 1);
      else if (/\.(?:log|txt|jsonl)$/i.test(entry.name)) found.push(target);
    }
  };
  await walk(root, 0);
  return found;
}

export class YougileIssueReporter {
  private readonly http: YougileIssueHttp;
  private readonly now: () => Date;
  private readonly pickedImages = new Map<string, PickedImage>();
  private capabilityCache?: {
    at: number;
    value: CukiiIssueReportCapability;
  };
  private capabilityInFlight?: Promise<CukiiIssueReportCapability>;
  private flushInFlight?: Promise<void>;
  private readonly reportAttempts = new Map<
    string,
    Promise<CukiiIssueReportReceipt>
  >();
  private readonly activeStagingDirectories = new Set<string>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  private started = false;

  constructor(private readonly host: YougileIssueReporterHost) {
    this.http = host.http ?? defaultHttp;
    this.now = host.now ?? (() => new Date());
  }

  private pendingRoot(): string {
    return path.join(this.host.storageRoot, "pending");
  }

  private sentRoot(): string {
    return path.join(this.host.storageRoot, "sent");
  }

  private stagingRoot(): string {
    return path.join(this.host.storageRoot, "staging");
  }

  private reportDir(reportId: string): string {
    return path.join(this.pendingRoot(), reportId);
  }

  private reportFile(reportId: string): string {
    return path.join(this.reportDir(reportId), "report.json");
  }

  private receiptFile(reportId: string): string {
    return path.join(this.sentRoot(), `${reportId}.json`);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Warm the board-access capability at extension activation, before the
    // user can open the command menu. The webview's mount-time request can
    // then reuse this in-flight/cached result instead of making the menu wait.
    void this.capability().catch(() => undefined);
    void this.flush();
  }

  dispose(): void {
    this.started = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.pickedImages.clear();
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.flush();
      },
      Math.max(1_000, delayMs),
    );
  }

  async capability(force = false): Promise<CukiiIssueReportCapability> {
    const now = Date.now();
    if (
      !force &&
      this.capabilityCache &&
      now - this.capabilityCache.at < 15_000
    ) {
      return this.capabilityCache.value;
    }
    if (this.capabilityInFlight) {
      if (!force) return this.capabilityInFlight;
      // A click on the command menu is an explicit refresh. If the mount-time
      // probe is still finishing, wait for it and then probe again rather than
      // returning a result captured before the board was shared/revoked.
      await this.capabilityInFlight;
    }
    this.capabilityInFlight = this.probeCapability().finally(() => {
      this.capabilityInFlight = undefined;
    });
    const value = await this.capabilityInFlight;
    this.capabilityCache = { at: Date.now(), value };
    return value;
  }

  private async credential(): Promise<
    { key: string; accountLabel?: string } | CukiiIssueReportCapability
  > {
    const account = await readYougileAccount(
      this.host.store,
      this.host.environment ?? {},
    );
    if (!account) {
      return { available: false, reason: "not_authenticated" };
    }
    const probe = await probeYougileKey(account.key, {
      http: (url, init) =>
        this.http(url, {
          method: "GET",
          headers: init.headers,
          signal: init.signal,
        }),
    });
    if (probe.verdict === "rejected") {
      return { available: false, reason: "not_authenticated" };
    }
    if (probe.verdict === "unreachable") {
      return { available: false, reason: "unreachable" };
    }
    return {
      key: account.key,
      accountLabel: probe.email ?? account.accountLabel,
    };
  }

  private async probeCapability(): Promise<CukiiIssueReportCapability> {
    const credential = await this.credential();
    if (!("key" in credential)) return credential;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const query = new URLSearchParams({
        projectId: CUKII_BUGS_PROJECT_ID,
        limit: "1000",
      });
      const response = await this.http(
        `${YOUGILE_API_BASE}/boards?${query.toString()}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${credential.key}` },
          signal: controller.signal,
        },
      );
      if (response.status === 401 || response.status === 403) {
        return { available: false, reason: "not_authenticated" };
      }
      if (!response.ok) return { available: false, reason: "unreachable" };
      const body = await response.json();
      const boardVisible = content(body).some(
        (board) => (board as { id?: unknown }).id === CUKII_BUGS_BOARD_ID,
      );
      return boardVisible
        ? {
            available: true,
            reason: "available",
            ...(credential.accountLabel
              ? { accountLabel: credential.accountLabel }
              : {}),
          }
        : { available: false, reason: "board_unavailable" };
    } catch {
      return { available: false, reason: "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  async registerPickedImages(
    files: string[],
  ): Promise<CukiiIssuePickedImage[]> {
    const result: CukiiIssuePickedImage[] = [];
    for (const file of files.slice(0, CUKII_ISSUE_MAX_IMAGES)) {
      const extension = path.extname(file).toLowerCase();
      const mimeType = IMAGE_MIME.get(extension);
      if (!mimeType)
        throw new Error("Only PNG, JPEG, WebP and GIF images are supported.");
      const stat = await fs.promises.stat(file);
      if (!stat.isFile())
        throw new Error("The selected attachment is not a file.");
      if (stat.size > CUKII_ISSUE_MAX_IMAGE_BYTES) {
        throw new Error("Each screenshot must be 5 MB or smaller.");
      }
      const id = crypto.randomUUID();
      const name = safeFileName(maskCukiiReportText(path.basename(file)));
      this.pickedImages.set(id, {
        path: file,
        name,
        size: stat.size,
        mimeType,
      });
      const bytes = await fs.promises.readFile(file);
      result.push({
        id,
        name,
        size: stat.size,
        mimeType,
        previewDataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
      });
    }
    return result;
  }

  releasePickedImages(attachmentIds: string[]): void {
    for (const id of attachmentIds) this.pickedImages.delete(id);
  }

  async prepare(
    sessionId: string,
    brokerModel: BrokerModel,
  ): Promise<CukiiIssueDiagnosticsPreview> {
    const lines = await this.diagnosticLines(sessionId, brokerModel);
    return {
      extensionVersion: this.host.extensionVersion,
      operatingSystem: this.host.operatingSystem,
      remote: this.host.remote(),
      workspace: this.host.workspace().map(maskCukiiReportText),
      sessionId,
      brokerModel,
      // The dialog is itself scrollable; returning the complete sanitized
      // collection makes the preview honest. Submission refreshes this same
      // collection and persists it as cukii-diagnostics.txt.
      logLines: lines,
    };
  }

  private async diagnosticLines(
    sessionId: string,
    brokerModel: BrokerModel,
  ): Promise<string[]> {
    const header = [
      `Cukii: ${this.host.extensionVersion}`,
      `VS Code: ${this.host.vscodeVersion}`,
      `OS: ${this.host.operatingSystem}`,
      `Remote: ${this.host.remote()}`,
      `Workspace: ${this.host.workspace().join(", ") || "none"}`,
      `Session: ${sessionId}`,
      `Model: ${brokerModel}`,
    ];
    const ring = recentCukiiDiagnostics(120, sessionId);
    const disk: string[] = [];
    let remaining = 64 * 1024;
    for (const file of await logFiles(this.host.logRoot)) {
      if (remaining <= 0) break;
      try {
        const tail = await tailFile(file, Math.min(16 * 1024, remaining));
        remaining -= Buffer.byteLength(tail);
        if (tail.trim()) {
          disk.push(`--- ${path.basename(file)} ---`, ...tail.split(/\r?\n/));
        }
      } catch {
        // A log may rotate between listing and reading; diagnostics remain
        // best-effort and the durable report must still be accepted.
      }
    }
    return [...header, ...ring, ...disk]
      .map((line) => maskCukiiReportText(line).slice(0, 2_000))
      .filter(Boolean)
      .slice(-200);
  }

  private validateSubmission(submission: CukiiIssueReportSubmission): void {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(submission.reportId)) {
      throw new Error("Invalid report id.");
    }
    if (!submission.title.trim()) throw new Error("Title is required.");
    if (submission.title.trim().length > CUKII_ISSUE_MAX_TITLE) {
      throw new Error(
        `Title must be ${CUKII_ISSUE_MAX_TITLE} characters or fewer.`,
      );
    }
    for (const value of [
      submission.stepsToReproduce,
      submission.expectedResult,
      submission.actualResult,
    ]) {
      if (value.length > CUKII_ISSUE_MAX_FIELD) {
        throw new Error(
          `Each description field must be ${CUKII_ISSUE_MAX_FIELD} characters or fewer.`,
        );
      }
    }
    if (submission.attachmentIds.length > CUKII_ISSUE_MAX_IMAGES) {
      throw new Error(
        `Attach no more than ${CUKII_ISSUE_MAX_IMAGES} screenshots.`,
      );
    }
  }

  async submit(
    submission: CukiiIssueReportSubmission,
  ): Promise<CukiiIssueReportReceipt> {
    this.validateSubmission(submission);
    return this.withReportAttemptLock(submission.reportId, async () => {
      const existingReceipt = await this.readReceipt(submission.reportId);
      if (existingReceipt) return existingReceipt;
      let stored = await this.readReport(submission.reportId);
      if (!stored) stored = await this.persistSubmission(submission);
      this.releasePickedImages(submission.attachmentIds);
      return this.attempt(stored);
    });
  }

  private withReportAttemptLock(
    reportId: string,
    operation: () => Promise<CukiiIssueReportReceipt>,
  ): Promise<CukiiIssueReportReceipt> {
    const existing = this.reportAttempts.get(reportId);
    if (existing) return existing;

    let tracked!: Promise<CukiiIssueReportReceipt>;
    tracked = operation().finally(() => {
      if (this.reportAttempts.get(reportId) === tracked) {
        this.reportAttempts.delete(reportId);
      }
    });
    this.reportAttempts.set(reportId, tracked);
    return tracked;
  }

  private async persistSubmission(
    submission: CukiiIssueReportSubmission,
  ): Promise<StoredIssueReport> {
    const directory = path.join(
      this.stagingRoot(),
      `.staging-${submission.reportId}-${process.pid}-${crypto.randomUUID()}`,
    );
    await Promise.all([
      fs.promises.mkdir(this.pendingRoot(), { recursive: true }),
      fs.promises.mkdir(this.stagingRoot(), { recursive: true }),
    ]);
    await fs.promises.mkdir(directory, { recursive: false });
    this.activeStagingDirectories.add(directory);
    const files: LocalIssueFile[] = [];

    try {
      if (submission.snapshot?.pngBase64) {
        if (submission.snapshot.sanitizer !== "cukii-report-v1") {
          throw new Error("The automatic snapshot was not sanitized.");
        }
        const bytes = Buffer.from(submission.snapshot.pngBase64, "base64");
        if (
          bytes.length > CUKII_ISSUE_MAX_IMAGE_BYTES ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        ) {
          throw new Error(
            "The automatic snapshot is not a valid PNG under 5 MB.",
          );
        }
        const localName = "cukii-window.png";
        await atomicWrite(path.join(directory, localName), bytes);
        files.push({
          kind: "snapshot",
          name: localName,
          mimeType: "image/png",
          localName,
        });
      }

      for (let index = 0; index < submission.attachmentIds.length; index++) {
        const picked = this.pickedImages.get(submission.attachmentIds[index]);
        if (!picked)
          throw new Error("A selected screenshot expired. Choose it again.");
        const localName = `manual-${index}-${safeFileName(picked.name)}`;
        await fs.promises.copyFile(
          picked.path,
          path.join(directory, localName),
        );
        files.push({
          kind: "manual",
          name: maskCukiiReportText(picked.name),
          mimeType: picked.mimeType,
          localName,
        });
      }

      const diagnostics = (
        await this.diagnosticLines(submission.sessionId, submission.brokerModel)
      ).join("\n");
      const diagnosticsName = "cukii-diagnostics.txt";
      await atomicWrite(path.join(directory, diagnosticsName), diagnostics);
      files.push({
        kind: "diagnostics",
        name: diagnosticsName,
        mimeType: "text/plain",
        localName: diagnosticsName,
      });

      const createdAt = this.now().toISOString();
      const stored: StoredIssueReport = {
        schemaVersion: 1,
        reportId: submission.reportId,
        createdAt,
        title: maskCukiiReportText(submission.title.trim()),
        stepsToReproduce: maskCukiiReportText(
          submission.stepsToReproduce.trim(),
        ),
        expectedResult: maskCukiiReportText(submission.expectedResult.trim()),
        actualResult: maskCukiiReportText(submission.actualResult.trim()),
        severity: submission.severity,
        sessionId: submission.sessionId,
        brokerModel: submission.brokerModel,
        files,
        attempts: 0,
        nextAttemptAt: createdAt,
      };
      await atomicWrite(
        path.join(directory, "report.json"),
        `${JSON.stringify(stored, null, 2)}\n`,
      );
      const finalDirectory = this.reportDir(submission.reportId);
      try {
        await fs.promises.rename(directory, finalDirectory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") {
          throw error;
        }
        const existing = await this.readReport(submission.reportId);
        if (!existing) throw error;
        return existing;
      }
      return stored;
    } finally {
      this.activeStagingDirectories.delete(directory);
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }

  private async cleanupStaging(): Promise<boolean> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.stagingRoot(), {
        withFileTypes: true,
      });
    } catch {
      return true;
    }
    const results = await Promise.all(
      entries.map(async (entry) => {
        const directory = path.join(this.stagingRoot(), entry.name);
        if (this.activeStagingDirectories.has(directory)) return true;
        return this.removeOrphan(directory, "staging");
      }),
    );
    return results.every(Boolean);
  }

  private async removeOrphan(
    directory: string,
    kind: "staging" | "legacy-pending",
  ): Promise<boolean> {
    try {
      await fs.promises.rm(directory, { recursive: true, force: true });
      return true;
    } catch (error) {
      // Cleanup is privacy-sensitive, but one locked Windows file must never
      // block delivery/retry of every valid report beside it.
      recordCukiiDiagnostic("yougile.report.orphan_cleanup_failed", {
        kind,
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
      return false;
    }
  }

  private async writeReport(report: StoredIssueReport): Promise<void> {
    await atomicWrite(
      this.reportFile(report.reportId),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }

  private async readReport(
    reportId: string,
  ): Promise<StoredIssueReport | undefined> {
    try {
      return JSON.parse(
        await fs.promises.readFile(this.reportFile(reportId), "utf8"),
      ) as StoredIssueReport;
    } catch {
      return undefined;
    }
  }

  private async readReceipt(
    reportId: string,
  ): Promise<CukiiIssueReportReceipt | undefined> {
    try {
      return JSON.parse(
        await fs.promises.readFile(this.receiptFile(reportId), "utf8"),
      ) as CukiiIssueReportReceipt;
    } catch {
      return undefined;
    }
  }

  private async attempt(
    report: StoredIssueReport,
  ): Promise<CukiiIssueReportReceipt> {
    try {
      const receipt = await this.deliver(report);
      await atomicWrite(
        this.receiptFile(report.reportId),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      await fs.promises.rm(this.reportDir(report.reportId), {
        recursive: true,
        force: true,
      });
      return receipt;
    } catch (error) {
      report.attempts += 1;
      const delay =
        error instanceof DeliveryError
          ? Math.max(error.retryAfterMs, retryDelay(report.attempts))
          : retryDelay(report.attempts);
      report.nextAttemptAt = new Date(
        this.now().getTime() + delay,
      ).toISOString();
      report.lastError = maskCukiiReportText(
        error instanceof Error ? error.message : String(error),
      ).slice(0, 500);
      await this.writeReport(report);
      this.schedule(delay);
      return {
        reportId: report.reportId,
        status: "queued",
        ...(report.taskId ? { taskId: report.taskId } : {}),
        message:
          "Saved locally. Cukii will retry delivery to YouGile automatically.",
      };
    }
  }

  private async requestJson(
    key: string,
    route: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await this.http(`${YOUGILE_API_BASE}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryAfter = Number(response.headers?.get("retry-after") ?? 0);
        throw new DeliveryError(
          `YouGile ${method} ${route} returned ${response.status}.`,
          response.status === 429
            ? Math.max(60_000, retryAfter * 1_000)
            : response.status >= 500
              ? 30_000
              : 300_000,
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError(
        `YouGile ${method} ${route} could not be reached.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async uploadFile(
    key: string,
    report: StoredIssueReport,
    file: LocalIssueFile,
  ): Promise<string> {
    const bytes = await fs.promises.readFile(
      path.join(this.reportDir(report.reportId), file.localName),
    );
    const boundary = `----cukii-${crypto.randomUUID()}`;
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName(file.name)}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      "utf8",
    );
    const body = Buffer.concat([
      header,
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await this.http(`${YOUGILE_API_BASE}/upload-file`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
        },
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DeliveryError(
          `YouGile upload returned ${response.status}.`,
          response.status >= 500 || response.status === 429 ? 60_000 : 300_000,
        );
      }
      const payload = (await response.json()) as { fullUrl?: unknown };
      if (typeof payload.fullUrl !== "string") {
        throw new DeliveryError("YouGile upload returned no public URL.");
      }
      const url = new URL(payload.fullUrl);
      const hostname = url.hostname.toLowerCase();
      if (
        url.protocol !== "https:" ||
        (hostname !== "yougile.com" && !hostname.endsWith(".yougile.com"))
      ) {
        throw new DeliveryError(
          "YouGile upload returned an unsafe URL.",
          300_000,
        );
      }
      return url.toString();
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError("YouGile upload could not be reached.", 60_000);
    } finally {
      clearTimeout(timer);
    }
  }

  private description(report: StoredIssueReport): string {
    // Keep exactly one carrier per file. YouGile and its Telegram bridge render
    // markdown/HTML anchors separately from the plain-text URL, producing a
    // dead decorative link next to the working download address.
    const links = report.files
      .filter((file) => file.remoteUrl)
      .map((file) => `- ${file.remoteUrl as string}`);
    const section = (title: string, body: string) =>
      `## ${title}\n${body || "_Not provided_"}`;
    return [
      `**Severity:** ${severityLabel(report.severity)}`,
      `**Reported:** ${report.createdAt}`,
      `**Cukii report ID:** \`${report.reportId}\``,
      "",
      section("Steps to reproduce", report.stepsToReproduce),
      "",
      section("Expected result", report.expectedResult),
      "",
      section("Actual result", report.actualResult),
      "",
      "## Attachments and diagnostics",
      ...(links.length ? links : ["_No files_"]),
      "",
      `<!-- cukii-report-id:${report.reportId} -->`,
    ].join("\n");
  }

  private async attachmentMessageExists(
    key: string,
    taskId: string,
    reportId: string,
  ): Promise<boolean> {
    const query = new URLSearchParams({ limit: "50", text: reportId });
    const body = await this.requestJson(
      key,
      `/chats/${encodeURIComponent(taskId)}/messages?${query.toString()}`,
      "GET",
    );
    return content(body).some((message) => {
      const item = message as { text?: unknown; textHtml?: unknown };
      return [item.text, item.textHtml].some(
        (value) => typeof value === "string" && value.includes(reportId),
      );
    });
  }

  private async deliver(
    report: StoredIssueReport,
  ): Promise<CukiiIssueReportReceipt> {
    const credential = await this.credential();
    if (!("key" in credential)) {
      throw new DeliveryError(
        credential.reason === "unreachable"
          ? "YouGile account status is temporarily unavailable."
          : "Sign in to YouGile before the queued report can be delivered.",
        300_000,
      );
    }
    const capability = await this.probeCapability();
    if (!capability.available) {
      throw new DeliveryError(
        capability.reason === "board_unavailable"
          ? "The YouGile account has no access to the Cukii Bugs board."
          : "The Cukii Bugs board is temporarily unavailable.",
        300_000,
      );
    }

    for (const file of report.files) {
      if (file.remoteUrl) continue;
      file.remoteUrl = await this.uploadFile(credential.key, report, file);
      await this.writeReport(report);
    }

    if (!report.taskId) {
      const created = (await this.requestJson(
        credential.key,
        "/tasks",
        "POST",
        {
          title: report.title,
          columnId: CUKII_BUGS_INBOX_COLUMN_ID,
          description: this.description(report),
          idempotencyKey: report.reportId,
        },
      )) as { id?: unknown };
      if (typeof created.id !== "string" || !created.id) {
        throw new DeliveryError("YouGile returned no task id.");
      }
      report.taskId = created.id;
      await this.writeReport(report);
    }

    if (!report.chatPosted) {
      const exists = await this.attachmentMessageExists(
        credential.key,
        report.taskId,
        report.reportId,
      );
      if (!exists) {
        const imageFiles = report.files.filter(
          (file) => file.kind !== "diagnostics" && file.remoteUrl,
        );
        const diagnostics = report.files.find(
          (file) => file.kind === "diagnostics",
        );
        // A bare URL is auto-linked by YouGile and its Telegram bridge. Keep
        // it in the HTML carrier only: the bridge
        // concatenates the two alternatives and would otherwise show it twice.
        const text = [
          `Cukii report ${report.reportId}: screenshots and diagnostics`,
        ].join("\n");
        const textHtml = [
          `<p>${escapeHtml(
            `Cukii report ${report.reportId}: screenshots and diagnostics`,
          )}</p>`,
          ...imageFiles.map(
            (file) =>
              `<p><strong>${escapeHtml(file.name)}</strong></p><img src="${escapeHtml(file.remoteUrl as string)}" alt="${escapeHtml(file.name)}">`,
          ),
          ...(diagnostics?.remoteUrl
            ? [
                `<p>${escapeHtml(diagnostics.remoteUrl)}</p>`,
                `<p>File: ${escapeHtml(diagnostics.name)}</p>`,
              ]
            : []),
        ].join("");
        await this.requestJson(
          credential.key,
          `/chats/${encodeURIComponent(report.taskId)}/messages`,
          "POST",
          { text, textHtml, label: "Cukii diagnostics" },
        );
      }
      report.chatPosted = true;
      await this.writeReport(report);
    }

    return {
      reportId: report.reportId,
      status: "sent",
      taskId: report.taskId,
      message: "Report sent to the Cukii Bugs board.",
    };
  }

  async flush(): Promise<void> {
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = this.flushPending().finally(() => {
      this.flushInFlight = undefined;
    });
    return this.flushInFlight;
  }

  private async flushPending(): Promise<void> {
    let cleanupRetryNeeded = !(await this.cleanupStaging());
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.pendingRoot(), {
        withFileTypes: true,
      });
    } catch {
      if (cleanupRetryNeeded) this.schedule(ORPHAN_CLEANUP_RETRY_MS);
      return;
    }
    let earliestNext: number | undefined;
    let processed = 0;
    let hasDeferredDueReport = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const report = await this.readReport(entry.name);
      if (!report) {
        // Before staged commits existed, a crash between copying an image and
        // writing report.json left private screenshots in pending forever.
        // A complete current report is committed atomically, so a directory
        // without its manifest is necessarily an orphan and must be removed.
        cleanupRetryNeeded =
          !(await this.removeOrphan(
            this.reportDir(entry.name),
            "legacy-pending",
          )) || cleanupRetryNeeded;
        continue;
      }
      const receipt = await this.readReceipt(report.reportId);
      if (receipt) {
        await fs.promises.rm(this.reportDir(report.reportId), {
          recursive: true,
          force: true,
        });
        continue;
      }
      const due = Date.parse(report.nextAttemptAt);
      if (Number.isFinite(due) && due > this.now().getTime()) {
        earliestNext = Math.min(earliestNext ?? due, due);
        continue;
      }
      // Keep each cycle well below YouGile's company-wide request budget, but
      // never strand the third (or later) due report. The old early `continue`
      // skipped those entries without scheduling another pass.
      if (processed >= 2) {
        hasDeferredDueReport = true;
        continue;
      }
      processed += 1;
      const result = await this.withReportAttemptLock(
        report.reportId,
        async () => {
          const receipt = await this.readReceipt(report.reportId);
          if (receipt) return receipt;
          const current = await this.readReport(report.reportId);
          return this.attempt(current ?? report);
        },
      );
      if (result.status === "queued") {
        const next = Date.parse(
          (await this.readReport(report.reportId))?.nextAttemptAt ?? "",
        );
        if (Number.isFinite(next))
          earliestNext = Math.min(earliestNext ?? next, next);
      }
    }
    if (hasDeferredDueReport) {
      earliestNext = Math.min(
        earliestNext ?? Number.POSITIVE_INFINITY,
        this.now().getTime() + 1_000,
      );
    }
    if (cleanupRetryNeeded) {
      earliestNext = Math.min(
        earliestNext ?? Number.POSITIVE_INFINITY,
        this.now().getTime() + ORPHAN_CLEANUP_RETRY_MS,
      );
    }
    if (earliestNext !== undefined) {
      this.schedule(Math.max(1_000, earliestNext - this.now().getTime()));
    }
  }
}

const reporters = new WeakMap<object, YougileIssueReporter>();

export function yougileIssueReporterForHost(
  key: object,
  host: YougileIssueReporterHost,
): YougileIssueReporter {
  const existing = reporters.get(key);
  if (existing) return existing;
  const reporter = new YougileIssueReporter(host);
  reporters.set(key, reporter);
  return reporter;
}
