import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CukiiIssueReportSubmission } from "core/protocol/ideWebview";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtectedSecretStore } from "./alibabaTokenPlan";
import {
  clearCukiiDiagnosticsForTest,
  recordCukiiDiagnostic,
} from "./cukiiDiagnosticBuffer";
import {
  CUKII_BUGS_BOARD_ID,
  YougileIssueReporter,
  type YougileIssueHttp,
  type YougileIssueReporterHost,
} from "./yougileIssueReporter";
import { YOUGILE_SECRET_KEY } from "./yougileAccount";

const KEY = "yougile-test-key-abcdefghijklmnopqrstuvwxyz";
const PNG_BASE64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

type RecordedCall = {
  url: string;
  method: "GET" | "POST";
  body?: string | Buffer;
};

const roots: string[] = [];
const reporters: YougileIssueReporter[] = [];

afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.dispose();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  clearCukiiDiagnosticsForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function secretStore(): ProtectedSecretStore {
  const values = new Map([
    [
      YOUGILE_SECRET_KEY,
      JSON.stringify({ key: KEY, accountLabel: "qa@example.com" }),
    ],
  ]);
  return {
    get: async (key) => values.get(key),
    store: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  };
}

function response(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: { get: () => null },
  };
}

function submission(reportId: string): CukiiIssueReportSubmission {
  return {
    reportId,
    title: "Composer overlaps the transcript",
    stepsToReproduce: "Open Cukii and resize the panel.",
    expectedResult: "The composer stays within the panel.",
    actualResult: "The composer overlaps messages.",
    severity: "major",
    sessionId: "session-test",
    brokerModel: "codex-5-6-terra",
    attachmentIds: [],
    snapshot: {
      pngBase64: PNG_BASE64,
      width: 640,
      height: 480,
      sanitizer: "cukii-report-v1",
    },
  };
}

function fixture(
  options: {
    boardVisible?: boolean;
    failUploads?: boolean;
    uploadGate?: Promise<void>;
    onUploadStart?: () => void;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-issue-reporter-"));
  roots.push(root);
  const calls: RecordedCall[] = [];
  let boardVisible = options.boardVisible ?? true;
  let failUploads = options.failUploads ?? false;
  let uploadIndex = 0;
  let taskIndex = 0;

  const http: YougileIssueHttp = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.endsWith("/users/me")) {
      return response(200, { id: "user-1", email: "qa@example.com" });
    }
    if (url.includes("/boards?")) {
      return response(200, {
        content: boardVisible ? [{ id: CUKII_BUGS_BOARD_ID }] : [],
      });
    }
    if (url.endsWith("/upload-file")) {
      options.onUploadStart?.();
      if (options.uploadGate) await options.uploadGate;
      if (failUploads) return response(502, { error: "temporary" });
      uploadIndex += 1;
      return response(201, {
        fullUrl: `https://yougile.com/user-data/report/file-${uploadIndex}`,
      });
    }
    if (url.endsWith("/tasks") && init.method === "POST") {
      taskIndex += 1;
      return response(201, { id: `task-${taskIndex}` });
    }
    if (/\/chats\/[^/]+\/messages\?/.test(url)) {
      return response(200, { content: [] });
    }
    if (/\/chats\/[^/]+\/messages$/.test(url) && init.method === "POST") {
      return response(201, { id: "message-1" });
    }
    throw new Error(`Unexpected request: ${init.method} ${url}`);
  });

  let now = new Date("2026-09-07T12:00:00.000Z");
  const host: YougileIssueReporterHost = {
    storageRoot: root,
    store: secretStore(),
    environment: { env: {}, homedir: () => root, readFile: () => undefined },
    extensionVersion: "2.0.109",
    vscodeVersion: "1.99.0",
    operatingSystem: "win32 test x64",
    remote: () => "ssh-remote",
    workspace: () => ["customer-workspace"],
    http,
    now: () => new Date(now),
  };
  const reporter = new YougileIssueReporter(host);
  reporters.push(reporter);
  return {
    root,
    calls,
    reporter,
    setBoardVisible: (value: boolean) => (boardVisible = value),
    setFailUploads: (value: boolean) => (failUploads = value),
    advance: (milliseconds: number) =>
      (now = new Date(now.getTime() + milliseconds)),
  };
}

describe("YougileIssueReporter", () => {
  it("prewarms board capability when the extension worker starts", async () => {
    const fx = fixture();

    fx.reporter.start();

    await vi.waitFor(() => {
      expect(fx.calls.some((call) => call.url.includes("/boards?"))).toBe(true);
    });
    const callsAfterWarmup = fx.calls.length;
    await expect(fx.reporter.capability()).resolves.toMatchObject({
      available: true,
      reason: "available",
    });
    expect(fx.calls).toHaveLength(callsAfterWarmup);
  });

  it("previews the complete sanitized diagnostic collection", async () => {
    const fx = fixture();
    for (let index = 0; index < 35; index++) {
      recordCukiiDiagnostic("bridge.test", { index });
    }

    const preview = await fx.reporter.prepare(
      "session-test",
      "codex-5-6-terra",
    );

    expect(preview.logLines.length).toBeGreaterThan(35);
    expect(preview.logLines).toContainEqual(
      expect.stringContaining('"index":0'),
    );
    expect(preview.logLines).toContainEqual(
      expect.stringContaining('"index":34'),
    );
  });

  it("exposes Report an issue only when the exact Cukii Bugs board is visible", async () => {
    const unavailable = fixture({ boardVisible: false });
    await expect(unavailable.reporter.capability(true)).resolves.toEqual({
      available: false,
      reason: "board_unavailable",
    });

    const available = fixture();
    await expect(available.reporter.capability(true)).resolves.toMatchObject({
      available: true,
      reason: "available",
      accountLabel: "qa@example.com",
    });
  });

  it("persists a 502, retries it, and creates exactly one idempotent task", async () => {
    const fx = fixture({ failUploads: true });
    recordCukiiDiagnostic("bridge.run.failed", {
      token: "super-secret-diagnostic-token",
      user: "qa@example.com",
      windowsPath: "D:\\Brain\\clients\\secret\\a.ts",
      uncPath: "\\\\fileserver\\customer-share\\private.log",
      posixPath: "/srv/customer/acme/private.log",
    });

    const manualPath = path.join(fx.root, "qa@example.com.png");
    fs.writeFileSync(manualPath, Buffer.from(PNG_BASE64, "base64"));
    const [manual] = await fx.reporter.registerPickedImages([manualPath]);
    const sensitiveSubmission = submission("report-0001");
    sensitiveSubmission.actualResult =
      "token=typed-secret-value, contact qa@example.com";
    sensitiveSubmission.attachmentIds = [manual.id];

    const queued = await fx.reporter.submit(sensitiveSubmission);
    expect(queued.status).toBe("queued");
    const pending = path.join(fx.root, "pending", "report-0001");
    expect(fs.existsSync(path.join(pending, "report.json"))).toBe(true);
    const stored = fs.readFileSync(path.join(pending, "report.json"), "utf8");
    expect(stored).not.toContain("typed-secret-value");
    expect(stored).not.toContain("qa@example.com");
    const diagnostics = fs.readFileSync(
      path.join(pending, "cukii-diagnostics.txt"),
      "utf8",
    );
    expect(diagnostics).not.toContain("super-secret-diagnostic-token");
    expect(diagnostics).not.toContain("qa@example.com");
    expect(diagnostics).not.toContain("D:\\Brain\\clients");
    expect(diagnostics).not.toContain("\\\\fileserver");
    expect(diagnostics).not.toContain("/srv/customer");

    fx.setFailUploads(false);
    fx.advance(61_000);
    await fx.reporter.flush();

    expect(fs.existsSync(pending)).toBe(false);
    const sent = await fx.reporter.submit(sensitiveSubmission);
    expect(sent).toMatchObject({ status: "sent", taskId: "task-1" });

    const taskCalls = fx.calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/tasks"),
    );
    expect(taskCalls).toHaveLength(1);
    expect(JSON.parse(String(taskCalls[0].body))).toMatchObject({
      columnId: "a00a7ee9-dd85-4053-8309-1e5ceb402a40",
      idempotencyKey: "report-0001",
    });
    const message = fx.calls.find(
      (call) =>
        call.method === "POST" && /\/chats\/task-1\/messages$/.test(call.url),
    );
    expect(JSON.parse(String(message?.body))).toMatchObject({
      label: "Cukii diagnostics",
    });
    expect(JSON.parse(String(message?.body)).textHtml).toContain("<img src=");
    expect(
      fx.calls.map((call) => String(call.body ?? "")).join("\n"),
    ).not.toContain("typed-secret-value");
    const uploadedBodies = fx.calls
      .filter((call) => call.url.endsWith("/upload-file"))
      .map((call) => String(call.body ?? ""))
      .join("\n");
    expect(uploadedBodies).not.toContain("D:\\Brain\\clients");
    expect(uploadedBodies).not.toContain("\\\\fileserver");
    expect(uploadedBodies).not.toContain("/srv/customer");
  });

  it("schedules another bounded pass instead of stranding the third report", async () => {
    vi.useFakeTimers();
    const fx = fixture({ failUploads: true });
    for (const id of ["report-1001", "report-1002", "report-1003"]) {
      expect((await fx.reporter.submit(submission(id))).status).toBe("queued");
    }

    fx.setFailUploads(false);
    fx.advance(61_000);
    fx.reporter.start();
    await fx.reporter.flush();
    expect(
      fx.calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/tasks"),
      ),
    ).toHaveLength(2);

    fx.advance(1_100);
    await vi.advanceTimersByTimeAsync(1_100);
    await fx.reporter.flush();
    expect(
      fx.calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/tasks"),
      ),
    ).toHaveLength(3);
    expect(fs.readdirSync(path.join(fx.root, "pending"))).toHaveLength(0);
  });

  it("serializes a direct submit with a simultaneous outbox flush", async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let markUploadStarted!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    const fx = fixture({
      uploadGate,
      onUploadStart: markUploadStarted,
    });

    const direct = fx.reporter.submit(submission("report-race-0001"));
    await uploadStarted;
    const background = fx.reporter.flush();
    releaseUpload();

    const [receipt] = await Promise.all([direct, background]);
    expect(receipt).toMatchObject({ status: "sent", taskId: "task-1" });
    expect(
      fx.calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/upload-file"),
      ),
    ).toHaveLength(2);
    expect(
      fx.calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/tasks"),
      ),
    ).toHaveLength(1);
    expect(
      fx.calls.filter(
        (call) =>
          call.method === "POST" && /\/chats\/task-1\/messages$/.test(call.url),
      ),
    ).toHaveLength(1);
  });

  it("cleans crash orphans before reading the durable outbox", async () => {
    const fx = fixture();
    const staged = path.join(
      fx.root,
      "staging",
      ".staging-report-crash-123-dead-process",
    );
    fs.mkdirSync(staged, { recursive: true });
    fs.writeFileSync(path.join(staged, "manual-0-private.png"), "private");

    // Fault state produced by the legacy implementation when the process
    // died after copyFile/diagnostics but before report.json was committed.
    const legacyPending = path.join(fx.root, "pending", "report-legacy-crash");
    fs.mkdirSync(legacyPending, { recursive: true });
    fs.writeFileSync(
      path.join(legacyPending, "manual-0-private.png"),
      "private",
    );

    await fx.reporter.flush();

    expect(fs.existsSync(staged)).toBe(false);
    expect(fs.existsSync(legacyPending)).toBe(false);
    expect(fs.existsSync(path.join(fx.root, "pending", "report-crash"))).toBe(
      false,
    );
  });

  it("delivers valid reports when a stale staging file is locked", async () => {
    const fx = fixture({ failUploads: true });
    expect((await fx.reporter.submit(submission("report-valid"))).status).toBe(
      "queued",
    );
    fx.setFailUploads(false);
    fx.advance(61_000);

    const locked = path.join(fx.root, "staging", ".staging-locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "manual-private.png"), "private");
    const realRm = fs.promises.rm.bind(fs.promises);
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === locked) {
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      }
      return realRm(target, options);
    });

    await expect(fx.reporter.flush()).resolves.toBeUndefined();
    expect(fs.existsSync(locked)).toBe(true);
    expect(
      fx.calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/tasks"),
      ),
    ).toHaveLength(1);
    expect(fs.existsSync(path.join(fx.root, "pending", "report-valid"))).toBe(
      false,
    );
  });

  it("retries cleanup after a staging file is unlocked without a new report", async () => {
    vi.useFakeTimers();
    const fx = fixture();
    const locked = path.join(fx.root, "staging", ".staging-unlock-later");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "manual-private.png"), "private");
    const realRm = fs.promises.rm.bind(fs.promises);
    let lockedOnce = true;
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target) === locked && lockedOnce) {
        lockedOnce = false;
        throw Object.assign(new Error("locked"), { code: "EPERM" });
      }
      return realRm(target, options);
    });

    fx.reporter.start();
    await fx.reporter.flush();
    expect(fs.existsSync(locked)).toBe(true);
    fx.advance(30_100);
    await vi.advanceTimersByTimeAsync(30_100);
    await fx.reporter.flush();
    expect(fs.existsSync(locked)).toBe(false);
  });
});
