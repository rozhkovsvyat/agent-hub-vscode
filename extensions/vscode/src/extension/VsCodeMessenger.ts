import { ConfigHandler } from "core/config/ConfigHandler";
import { DataLogger } from "core/data/log";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import {
  FromCoreProtocol,
  FromWebviewProtocol,
  ToCoreProtocol,
} from "core/protocol";
import { ToWebviewFromCoreProtocol } from "core/protocol/coreWebview";
import { ToIdeFromWebviewOrCoreProtocol } from "core/protocol/ide";
import { ToIdeFromCoreProtocol } from "core/protocol/ideCore";
import type {
  BrokerAutocompact,
  BrokerEffort,
  BrokerModel,
  BrokerSpeed,
  BrokerSubagent,
  BrokerVendorAuthAction,
  BrokerVendorId,
  CukiiBridgeRunCompletion,
  CukiiCancelReceipt,
  CukiiInboxReceipt,
  CukiiIssueReportReceipt,
  CukiiPermissionMode,
  CukiiSteerReceipt,
  CukiiVendorUsageSnapshot,
  CukiiVendorUsageWindow,
} from "core/protocol/ideWebview";
import { CUKII_DEFAULT_BROKER_MODEL } from "core/cukiiAlibabaCatalog";
import {
  brokerVendorForModel,
  coerceStoredPermissionMode,
} from "core/cukiiPermissionModes";
import { InProcessMessenger, Message } from "core/protocol/messenger";
import {
  CORE_TO_WEBVIEW_PASS_THROUGH,
  WEBVIEW_TO_CORE_PASS_THROUGH,
} from "core/protocol/passThrough";
import { stripImages } from "core/util/messageContent";
import * as vscode from "vscode";

import { ApplyManager } from "../apply";
import {
  activeCukiiChatContext,
  cukiiPanelRegistry,
  listOpenCukiiPanels,
  syncCukiiPanelTitleForSession,
} from "../cukiiPanelRegistry";
import { VerticalDiffManager } from "../diff/vertical/manager";
import { addCurrentSelectionToEdit } from "../quickEdit/AddCurrentSelection";
import EditDecorationManager from "../quickEdit/EditDecorationManager";
import { handleLLMError } from "../util/errorHandling";
import { showTutorial } from "../util/tutorial";
import { getExtensionUri } from "../util/vscode";
import { VsCodeIde } from "../VsCodeIde";
import { VsCodeWebviewProtocol } from "../webviewProtocol";

import { VsCodeExtension } from "./VsCodeExtension";
import "./vendorBridgeHost";
import { BridgeImageScope } from "@cukii/vendor-bridge";
import {
  isClaudeNativeModel,
  streamBridgeChat,
  supportsBrokerInbox,
  type ClaudePermissionTransport,
} from "@cukii/vendor-bridge";
import {
  BridgeInboxWatch,
  bridgeInboxMessageStatus,
  purgeUnreadBridgeInboxMessages,
  writeBridgeInboxMessageWithReceipt,
} from "@cukii/vendor-bridge";
import type { ClaudePermissionBroker } from "@cukii/vendor-bridge";
import { exportAutocompactForHarness } from "./cukiiAutocompactExport";
import { cukiiSessionAttention } from "./cukiiSessionAttention";
import {
  listBrokerModelCatalog,
  resetClaudeCatalogProbeCache,
} from "@cukii/vendor-bridge";
import {
  cancelVoiceRecording,
  resolveWhisperTranscribeLanguage,
  startVoiceRecording,
  stopVoiceRecording,
  voiceRecordingStatus,
} from "./voiceDictation";
import { BridgeSteeringController } from "@cukii/vendor-bridge";
import { BridgeRunCancellation } from "@cukii/vendor-bridge";
import {
  isBridgeProcessTreeAlive,
  manualTreeKillCommand,
  retryBridgeTreeKill,
} from "@cukii/vendor-bridge";
import { retryBridgeTeardownOnDispose } from "@cukii/vendor-bridge";
import {
  CREDENTIAL_API_OPT_IN_VENDORS,
  createUsagePoller,
  type VendorUsagePoller,
} from "@cukii/vendor-bridge";
import {
  BridgeRunCoordinator,
  bridgeInboxNudgeText,
  bridgeRunAcceptsSteer,
  selectBridgeRunForSteer,
  type BridgeRunIdentity,
} from "@cukii/vendor-bridge";
import {
  allVendorPermissionCapabilities,
  vendorPermissionCapabilities,
} from "@cukii/vendor-bridge";
import { runAlibabaAuthAction } from "@cukii/vendor-bridge";
import type { DeviceAuthLoginResult } from "@cukii/vendor-bridge";
import type { ChildProcess } from "child_process";
import {
  clearBrokerVendorAccountCache,
  deviceAuthLoginArgs,
  extractAuthFlowAssist,
  logoutNativeKimiAccount,
  probeBrokerVendorAccount,
  runDeviceAuthLogin,
  terminateDeviceAuthChild,
  vendorAuthTerminalCommand,
  vendorInstallTerminalOutcome,
  vendorUsageEndpointSupported,
  watchVendorAuthTransition,
} from "@cukii/vendor-bridge";
import { listCukiiAccounts } from "./cukiiAccounts";
import { isYougileAccountId, runYougileAuthAction } from "./yougileAccount";
import { recordCukiiDiagnostic } from "./cukiiDiagnosticBuffer";
import { yougileIssueReporterForContext } from "./yougileIssueReporterVscode";
import { isRealPanelSessionTransition } from "./panelSessionTransition";
import { BridgeQuestionBroker } from "./bridgeQuestions";
import { BridgeReactionBroker } from "./bridgeReactions";
import { terminalCloseAfterAuthGrace } from "./authTerminalGrace";
import {
  cukiiMemoryAccountForContext,
  isCukiiMemoryAccountId,
  type CukiiMemoryLaunchBinding,
} from "./cukiiMemoryAccount";
import {
  CUKII_MANAGED_AUTO_UPDATE_VENDORS,
  managedVendorAutoUpdateSpec,
  runVendorInstallProcess,
  vendorSpawnEnv,
} from "@cukii/vendor-bridge";
import {
  VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS,
  VENDOR_CLI_UPDATE_IDLE_RETRY_MS,
  VENDOR_CLI_UPDATE_INSTALL_TIMEOUT_MS,
  VENDOR_CLI_UPDATE_START_DELAY_MS,
  VENDOR_CLI_UPDATE_STATE_KEY,
  type VendorCliUpdateState,
  vendorCliUpdateIsDue,
} from "./vendorCliAutoUpdate";

type ToIdeOrWebviewFromCoreProtocol = ToIdeFromCoreProtocol &
  ToWebviewFromCoreProtocol;

function vendorUsageStorageKey(vendor: BrokerVendorId): string {
  return `cukii.vendorUsage.${vendor}`;
}

const CUKII_USAGE_POLLER_VENDORS = [
  "claude",
  "codex",
  "grok",
  "kimi",
  "qwen",
] as const;

function isUsagePollerVendor(
  vendor: BrokerVendorId,
): vendor is (typeof CUKII_USAGE_POLLER_VENDORS)[number] {
  return (CUKII_USAGE_POLLER_VENDORS as readonly string[]).includes(vendor);
}

function sourceProtocol(
  message: Message,
  fallback: VsCodeWebviewProtocol,
): VsCodeWebviewProtocol {
  return (
    (message as Message & { __cukiiWebviewProtocol?: VsCodeWebviewProtocol })
      .__cukiiWebviewProtocol ?? fallback
  );
}

type ActiveBridgeRun = BridgeRunIdentity & {
  streamMessageId: string;
  controller: AbortController;
  done: Promise<CukiiBridgeRunCompletion>;
  steering: BridgeSteeringController;
  cancellation: BridgeRunCancellation;
  imageScope: BridgeImageScope;
  questionBroker: BridgeQuestionBroker;
  reactionBroker?: BridgeReactionBroker;
};

type OwnedPermissionBroker = {
  runId: string;
  broker: ClaudePermissionBroker;
};

/**
 * A shared messenger class between Core and Webview
 * so we don't have to rewrite some of the handlers
 */
export class VsCodeMessenger {
  private readonly usageLog: vscode.OutputChannel;
  private readonly usagePoller: VendorUsagePoller;
  private vendorCliUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  private vendorCliUpdateRun: Promise<void> | undefined;
  private vendorCliUpdating: BrokerVendorId | undefined;
  private vendorCliUpdaterDisposed = false;
  /** Brokers are scoped to the exact webview protocol that created the run. */
  private readonly claudePermissionBrokers = new Map<
    VsCodeWebviewProtocol,
    Set<OwnedPermissionBroker>
  >();
  /** Includes candidates waiting behind process-tree teardown. Stop/Escape is
   * bound to the exact run even before that candidate becomes active. */
  private readonly bridgeRunCandidates = new Map<
    VsCodeWebviewProtocol,
    Map<string, ActiveBridgeRun>
  >();
  private readonly panelSessionIds = new Map<VsCodeWebviewProtocol, string>();
  private readonly bridgeRuns = new BridgeRunCoordinator<
    VsCodeWebviewProtocol,
    ActiveBridgeRun
  >(22_000, { isPidAlive: (pid) => isBridgeProcessTreeAlive(pid) });
  private nextBridgeRunId = 0;
  /** One shared panel for managed codex device-auth output (Fable MINOR-5). */
  private codexLoginOutput: vscode.OutputChannel | undefined;
  private codexLoginInFlight = false;
  /** Detached login children must die with the window (Fable M6c). */
  private readonly codexLoginChildren = new Set<ChildProcess>();
  /** Preserve click order when two panels rename the same session together. */
  private readonly sessionRenameQueues = new Map<string, Promise<unknown>>();

  private publishVendorUsage(
    vendor: BrokerVendorId,
    windows: CukiiVendorUsageWindow[],
  ): void {
    const snapshot: CukiiVendorUsageSnapshot = {
      vendor,
      windows,
      observedAt: Math.floor(Date.now() / 1_000),
    };
    void Promise.resolve(
      this.context.globalState.update(vendorUsageStorageKey(vendor), snapshot),
    )
      .then(() => {
        this.webviewProtocol.send("cukii/vendorUsageChanged", snapshot);
      })
      .catch((error) => {
        this.usageLog.appendLine(
          `[${new Date().toISOString()}] ${vendor}: failed to persist usage snapshot: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  private scheduleManagedVendorCliUpdates(
    delayMs = VENDOR_CLI_UPDATE_START_DELAY_MS,
  ): void {
    if (this.vendorCliUpdaterDisposed || this.vendorCliUpdateTimer) return;
    this.vendorCliUpdateTimer = setTimeout(() => {
      this.vendorCliUpdateTimer = undefined;
      const run = this.updateManagedVendorClis()
        .catch((error) => {
          this.usageLog.appendLine(
            `[${new Date().toISOString()}] [cli-updater] unexpected failure: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          this.scheduleManagedVendorCliUpdates(
            VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS,
          );
        })
        .finally(() => {
          if (this.vendorCliUpdateRun === run) {
            this.vendorCliUpdateRun = undefined;
          }
        });
      this.vendorCliUpdateRun = run;
    }, delayMs);
    this.vendorCliUpdateTimer.unref?.();
  }

  private async updateManagedVendorClis(): Promise<void> {
    if (this.vendorCliUpdaterDisposed) return;
    if (this.bridgeRunCandidates.size > 0) {
      this.scheduleManagedVendorCliUpdates(VENDOR_CLI_UPDATE_IDLE_RETRY_MS);
      return;
    }

    const state =
      this.context.globalState.get<VendorCliUpdateState>(
        VENDOR_CLI_UPDATE_STATE_KEY,
      ) ?? {};
    for (const vendor of CUKII_MANAGED_AUTO_UPDATE_VENDORS) {
      if (this.vendorCliUpdaterDisposed) return;
      if (this.bridgeRunCandidates.size > 0) {
        this.scheduleManagedVendorCliUpdates(VENDOR_CLI_UPDATE_IDLE_RETRY_MS);
        return;
      }
      const spec = managedVendorAutoUpdateSpec(vendor);
      if (!spec) continue;
      const now = Date.now();
      const previous = state[vendor];
      if (!vendorCliUpdateIsDue(previous, now)) continue;

      state[vendor] = { attemptedAt: now };
      await this.context.globalState.update(VENDOR_CLI_UPDATE_STATE_KEY, state);
      this.usageLog.appendLine(
        `[${new Date(now).toISOString()}] [cli-updater] ${vendor}: checking npm latest`,
      );
      let output = "";
      this.vendorCliUpdating = vendor;
      let result;
      try {
        result = await runVendorInstallProcess(spec, {
          env: vendorSpawnEnv(),
          timeoutMs: VENDOR_CLI_UPDATE_INSTALL_TIMEOUT_MS,
          onOutput: (chunk) => {
            output = `${output}${chunk}`.slice(-8_192);
          },
        });
      } finally {
        if (this.vendorCliUpdating === vendor) {
          this.vendorCliUpdating = undefined;
        }
      }
      if (result.exitCode === 0 && !result.error) {
        state[vendor] = { attemptedAt: now, succeededAt: now };
        await this.context.globalState.update(
          VENDOR_CLI_UPDATE_STATE_KEY,
          state,
        );
        clearBrokerVendorAccountCache();
        if (vendor === "claude") resetClaudeCatalogProbeCache();
        this.usageLog.appendLine(
          `[${new Date().toISOString()}] [cli-updater] ${vendor}: updated successfully`,
        );
      } else {
        const reason =
          result.error?.message ??
          `exit ${result.exitCode ?? "unknown"}${
            result.signal ? ` (${result.signal})` : ""
          }`;
        this.usageLog.appendLine(
          `[${new Date().toISOString()}] [cli-updater] ${vendor}: ${reason}${
            output.trim() ? `\n${output.trim()}` : ""
          }`,
        );
      }
    }
    this.scheduleManagedVendorCliUpdates(VENDOR_CLI_UPDATE_FAILURE_INTERVAL_MS);
  }

  private enqueueSessionRename<T>(sessionId: string, work: () => Promise<T>) {
    const previous =
      this.sessionRenameQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    this.sessionRenameQueues.set(sessionId, current);
    const cleanup = () => {
      if (this.sessionRenameQueues.get(sessionId) === current) {
        this.sessionRenameQueues.delete(sessionId);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  private async cancelBridgeRun(
    protocol: VsCodeWebviewProtocol,
    run: ActiveBridgeRun,
    requestId: string,
  ): Promise<CukiiCancelReceipt> {
    const { alreadyCancelled, interrupted } = run.cancellation.cancel();
    // Abort starts an idempotent tree teardown inside bridgeChatAdapter. Do not
    // wait for the stream generator's `finally`: its consumer may already have
    // disappeared. Verify the owned tree directly and free the slot as soon as
    // it is dead so Stop -> next prompt is a fast, deterministic transition.
    if (run.childPid !== undefined) {
      const reaped = await retryBridgeTreeKill(run.childPid, {
        budgetMs: 7_000,
      });
      if (!reaped) {
        throw new Error(
          `Native bridge run ${run.runId} did not terminate; replacement is blocked. ` +
            `Reap it with: ${manualTreeKillCommand(run.childPid)}`,
        );
      }
      this.bridgeRuns.release(protocol, run);
      return {
        requestId,
        sessionId: run.sessionId,
        runId: run.runId,
        status: alreadyCancelled ? "already-cancelled" : "cancelled",
        interrupted,
        postMortem: true,
      };
    }
    // The run was cancelled before it reached spawn. launchBridgeChild checks
    // the same signal immediately before spawn, so no process can appear after
    // this slot is released.
    this.bridgeRuns.release(protocol, run);
    return {
      requestId,
      sessionId: run.sessionId,
      runId: run.runId,
      status: alreadyCancelled ? "already-cancelled" : "cancelled",
      interrupted,
    };
  }

  /** Dispose owns no user to recover for: retry a refused teardown once and
   * leave telemetry for any orphan that survives the retry. */
  private async teardownBridgeRunOnDispose(
    protocol: VsCodeWebviewProtocol,
    run: ActiveBridgeRun,
  ): Promise<void> {
    try {
      await this.cancelBridgeRun(protocol, run, `dispose:${run.sessionId}`);
    } catch {
      await retryBridgeTeardownOnDispose(run);
    }
  }

  /**
   * Publish the autocompact share where the machine's rotation hooks can read
   * it, and say so out loud when that fails.
   *
   * A dropped write is not harmless: the hooks keep using the previous
   * threshold while the UI shows the new one, and nothing in the window hints
   * at the disagreement. The export retries on its own; this is the last word.
   */
  private publishAutocompact(value: BrokerAutocompact): boolean {
    return exportAutocompactForHarness(
      value,
      undefined,
      (error) =>
        void vscode.window.showWarningMessage(
          `Cukii could not publish the Autocompact setting to the machine's rotation hooks; they keep the previous threshold. ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
    );
  }

  private panelIdForProtocol(protocol: VsCodeWebviewProtocol): string {
    return (
      cukiiPanelRegistry
        .values()
        .find((entry) => entry.panel.protocol === protocol)?.id ?? "sidebar"
    );
  }

  private addPermissionBroker(
    protocol: VsCodeWebviewProtocol,
    runId: string,
    broker: ClaudePermissionBroker,
  ): void {
    const brokers = this.claudePermissionBrokers.get(protocol) ?? new Set();
    brokers.add({ runId, broker });
    this.claudePermissionBrokers.set(protocol, brokers);
  }

  private removePermissionBroker(
    protocol: VsCodeWebviewProtocol,
    broker: ClaudePermissionBroker,
  ): void {
    const brokers = this.claudePermissionBrokers.get(protocol);
    if (!brokers) return;
    for (const owned of brokers) {
      if (owned.broker === broker) brokers.delete(owned);
    }
    if (brokers.size === 0) this.claudePermissionBrokers.delete(protocol);
  }

  private registerBridgeCandidate(
    protocol: VsCodeWebviewProtocol,
    run: ActiveBridgeRun,
  ): void {
    const candidates = this.bridgeRunCandidates.get(protocol) ?? new Map();
    candidates.set(run.runId, run);
    this.bridgeRunCandidates.set(protocol, candidates);
  }

  private removeBridgeCandidate(
    protocol: VsCodeWebviewProtocol,
    run: ActiveBridgeRun,
  ): void {
    const candidates = this.bridgeRunCandidates.get(protocol);
    if (!candidates || candidates.get(run.runId) !== run) return;
    candidates.delete(run.runId);
    if (candidates.size === 0) this.bridgeRunCandidates.delete(protocol);
  }

  private bridgeCandidateFor(
    protocol: VsCodeWebviewProtocol,
    identity: { runId?: string; streamMessageId?: string },
  ): ActiveBridgeRun | undefined {
    const candidates = this.bridgeRunCandidates.get(protocol);
    if (!candidates) return undefined;
    if (identity.runId) return candidates.get(identity.runId);
    if (identity.streamMessageId) {
      return [...candidates.values()].find(
        (run) => run.streamMessageId === identity.streamMessageId,
      );
    }
    return this.bridgeRuns.activeFor(protocol);
  }

  /**
   * Live-steer must bind to the run that will own stdin, including a candidate
   * still acquiring the slot. Routing only through `activeFor` deferred the
   * first follow-up of a new turn (one checkmark) while a later one landed
   * on the attached writer (two checkmarks) — ID-238.
   */
  private bridgeRunForSteer(
    protocol: VsCodeWebviewProtocol,
    request: { sessionId: string; brokerModel?: BrokerModel },
  ): ActiveBridgeRun | undefined {
    // Same panel first, then every other panel: a follow-up typed into a
    // second view of the same session, or after the picker model changed
    // mid-turn, must still reach the run that owns the FIFO/stdin (cards
    // 6aef19da, c20375e9).
    const own = this.bridgeRunCandidates.get(protocol);
    const groups: Iterable<ActiveBridgeRun>[] = [];
    if (own) groups.push(own.values());
    for (const [other, candidates] of this.bridgeRunCandidates) {
      if (other !== protocol) groups.push(candidates.values());
    }
    const active = this.bridgeRuns.activeFor(protocol);
    const selected = selectBridgeRunForSteer(request, active, groups);
    if (selected) return selected;
    for (const [other] of this.bridgeRunCandidates) {
      if (other === protocol) continue;
      const otherActive = this.bridgeRuns.activeFor(other);
      if (otherActive?.sessionId === request.sessionId) return otherActive;
    }
    return undefined;
  }

  private async runAuthTerminalFlow(
    terminal: vscode.Terminal,
    spec: {
      name: string;
      command: string;
      closesTerminal?: boolean;
    },
    vendor: BrokerVendorId,
    action: BrokerVendorAuthAction,
  ): Promise<{
    outcome:
      | "transition"
      | "command-failed"
      | "terminal-closed"
      | "cap"
      | "timeout";
    assisted: string[];
  }> {
    const assisted: string[] = [];
    // Subscribe before sending the command. A dependency preflight can reject
    // immediately, and missing that fast close left the Accounts loader stuck
    // until its five-minute cap.
    let closeSubscription: vscode.Disposable | undefined;
    const closed = new Promise<"terminal-closed">((resolve) => {
      closeSubscription = vscode.window.onDidCloseTerminal((closedTerminal) => {
        if (closedTerminal === terminal) resolve("terminal-closed");
      });
    });
    // Device-auth CLIs print a URL/code instead of opening a browser. Shell
    // integration is the only supported way to read terminal output; without
    // it the flow still works, just without the browser/clipboard assist.
    const watchOutput = (chunk: string) => {
      if (action !== "login") return;
      const assist = extractAuthFlowAssist(chunk);
      if (assist.url && !assisted.includes("url")) {
        assisted.push("url");
        void vscode.env.openExternal(vscode.Uri.parse(assist.url));
      }
      if (assist.code && !assisted.includes("code")) {
        assisted.push("code");
        void vscode.env.clipboard.writeText(assist.code);
      }
    };
    // Shell integration shipped in VS Code 1.93; the pinned 1.70 typings do
    // not declare it, so feature-detect a minimal shape at runtime instead.
    type TerminalShellIntegrationReader = {
      executeCommand: (command: string) => {
        read: () => AsyncIterable<string>;
      };
    };
    const shellIntegration = (
      terminal as vscode.Terminal & {
        shellIntegration?: TerminalShellIntegrationReader;
      }
    ).shellIntegration;
    if (shellIntegration) {
      const runThroughShell = (command: string) => {
        const stream = shellIntegration.executeCommand(command).read();
        void (async () => {
          try {
            for await (const chunk of stream) watchOutput(chunk);
          } catch {
            // Reading terminal output is best-effort assist only.
          }
        })();
      };
      runThroughShell(spec.command);
    } else {
      terminal.sendText(spec.command, true);
    }

    let capTimer: NodeJS.Timeout | undefined;
    const cap = new Promise<"cap">((resolve) => {
      capTimer = setTimeout(() => resolve("cap"), 300_000);
    });
    const controller = new AbortController();
    try {
      const terminalFinished =
        action === "install" && vendor !== "deepseek"
          ? closed.then(() => vendorInstallTerminalOutcome(vendor))
          : vendor !== "deepseek"
            ? terminalCloseAfterAuthGrace(closed, controller.signal)
            : closed;
      return {
        outcome:
          vendor !== "deepseek"
            ? await Promise.race([
                terminalFinished,
                cap,
                watchVendorAuthTransition(vendor, action, {
                  signal: controller.signal,
                }),
              ])
            : await Promise.race([terminalFinished, cap]),
        assisted,
      };
    } finally {
      controller.abort();
      closeSubscription?.dispose();
      if (capTimer) clearTimeout(capTimer);
    }
  }

  onWebview<T extends keyof FromWebviewProtocol>(
    messageType: T,
    handler: (
      message: Message<FromWebviewProtocol[T][0]>,
    ) => Promise<FromWebviewProtocol[T][1]> | FromWebviewProtocol[T][1],
  ): void {
    void this.webviewProtocol.on(messageType, handler);
  }

  onCore<T extends keyof ToIdeOrWebviewFromCoreProtocol>(
    messageType: T,
    handler: (
      message: Message<ToIdeOrWebviewFromCoreProtocol[T][0]>,
    ) =>
      | Promise<ToIdeOrWebviewFromCoreProtocol[T][1]>
      | ToIdeOrWebviewFromCoreProtocol[T][1],
  ): void {
    this.inProcessMessenger.externalOn(messageType, handler);
  }

  onWebviewOrCore<T extends keyof ToIdeFromWebviewOrCoreProtocol>(
    messageType: T,
    handler: (
      message: Message<ToIdeFromWebviewOrCoreProtocol[T][0]>,
    ) =>
      | Promise<ToIdeFromWebviewOrCoreProtocol[T][1]>
      | ToIdeFromWebviewOrCoreProtocol[T][1],
  ): void {
    this.onWebview(messageType, handler);
    this.onCore(messageType, handler);
  }

  constructor(
    private readonly inProcessMessenger: InProcessMessenger<
      ToCoreProtocol,
      FromCoreProtocol
    >,
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly ide: VsCodeIde,
    private readonly verticalDiffManagerPromise: Promise<VerticalDiffManager>,
    private readonly configHandlerPromise: Promise<ConfigHandler>,
    private readonly editDecorationManager: EditDecorationManager,
    private readonly context: vscode.ExtensionContext,
    private readonly vsCodeExtension: VsCodeExtension,
  ) {
    const issueReporter = yougileIssueReporterForContext(context);
    this.usageLog = vscode.window.createOutputChannel("Cukii Chat · usage");
    context.subscriptions.push(this.usageLog);
    this.usagePoller = createUsagePoller({
      vendors: CUKII_USAGE_POLLER_VENDORS,
      onUsage: (vendor, windows) => {
        // Gemini is supported by the reusable bridge poller for clients that
        // expose it as a first-class vendor. Cukii currently routes Gemini
        // models through Cursor, so it is deliberately not started here.
        if (vendor === "gemini") return;
        this.publishVendorUsage(vendor, windows);
      },
      log: (line) =>
        this.usageLog.appendLine(`[${new Date().toISOString()}] ${line}`),
      // Opt-in only (plan item 1): without it Claude/Codex stored logins are
      // never read for usage; their windows come from the CLIs themselves.
      credentialApiOptIn: vscode.workspace
        .getConfiguration("cukii")
        .get<boolean>("usage.directVendorApi", false)
        ? CREDENTIAL_API_OPT_IN_VENDORS
        : [],
    });
    this.usagePoller.start();
    context.subscriptions.push({ dispose: () => this.usagePoller.stop() });
    context.subscriptions.push({
      dispose: () => {
        // A detached device-auth child would otherwise outlive the window
        // and keep polling the vendor endpoint for up to 15 minutes.
        for (const child of this.codexLoginChildren) {
          terminateDeviceAuthChild(child);
        }
        this.codexLoginChildren.clear();
      },
    });
    this.scheduleManagedVendorCliUpdates();
    context.subscriptions.push({
      dispose: () => {
        this.vendorCliUpdaterDisposed = true;
        if (this.vendorCliUpdateTimer) {
          clearTimeout(this.vendorCliUpdateTimer);
          this.vendorCliUpdateTimer = undefined;
        }
      },
    });
    // Every discipline attempt lands here, success or failure. Without it the
    // only way to learn why a machine has no contract was to read the source.
    const memoryLog = vscode.window.createOutputChannel("Cukii Chat · memory");
    context.subscriptions.push(memoryLog);
    const memoryAccount = cukiiMemoryAccountForContext(context, (line) =>
      memoryLog.appendLine(`[${new Date().toISOString()}] ${line}`),
    );
    this.webviewProtocol.onDispose((protocol) => {
      const run = this.bridgeRuns.activeFor(protocol);
      // Invalidate candidates already waiting behind this run before their
      // cancellation barrier can resolve and start work for a disposed panel.
      this.bridgeRuns.forget(protocol);
      if (run) {
        // A refused teardown must not be swallowed: the retry confirms or
        // kills the tree, and a surviving orphan is logged with its pid.
        void this.teardownBridgeRunOnDispose(protocol, run);
      }
      const brokers = [...(this.claudePermissionBrokers.get(protocol) ?? [])];
      for (const { broker } of brokers) broker.denyAll();
      void Promise.all(brokers.map(({ broker }) => broker.dispose())).finally(
        () => {
          this.claudePermissionBrokers.delete(protocol);
          this.bridgeRunCandidates.delete(protocol);
          this.panelSessionIds.delete(protocol);
        },
      );
    });
    /** WEBVIEW ONLY LISTENERS **/
    this.onWebview("showFile", (msg) => {
      this.ide.openFile(msg.data.filepath);
    });

    this.onWebview("toggleDevTools", (msg) => {
      vscode.commands.executeCommand("continue.viewLogs");
    });

    this.onWebview("reloadWindow", (msg) => {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
    this.onWebview("focusEditor", (msg) => {
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    });
    this.onWebview("cukii/getActiveEditorSelectionState", () => {
      const editor = vscode.window.activeTextEditor;
      return { hasSelection: !!editor && !editor.selection.isEmpty };
    });
    this.onWebview("toggleFullScreen", (msg) => {
      vscode.commands.executeCommand("continue.openInNewWindow");
    });

    this.onWebview("cukii/openChatPanel", async ({ data }) => {
      await vscode.commands.executeCommand("continue.openInNewWindow", data);
    });

    this.onWebview("cukii/listOpenChatPanels", () => listOpenCukiiPanels());
    this.onWebview("cukii/getActiveChatContext", () =>
      activeCukiiChatContext(),
    );
    this.onWebview("cukii/getVendorUsage", async ({ data }) => {
      const cached = this.context.globalState.get<CukiiVendorUsageSnapshot>(
        vendorUsageStorageKey(data.vendor),
      );
      // The sidebar follows one active vendor. Probing every installed CLI on
      // each tab switch makes this decorative surface contend with the real
      // chat process and can hold the sidebar for multiple command timeouts.
      const accountPromise =
        data.vendor === "deepseek"
          ? Promise.resolve(undefined)
          : probeBrokerVendorAccount(data.vendor);
      const polledPromise = isUsagePollerVendor(data.vendor)
        ? this.usagePoller.pollOnce(data.vendor)
        : Promise.resolve([]);
      const [account, polledWindows] = await Promise.all([
        accountPromise,
        polledPromise,
      ]);
      // For vendors with no usage endpoint an empty poll is the final answer;
      // falling back to the cache there resurrected stale quota windows
      // (Fable review M3).
      const hasFreshUsage =
        polledWindows.length > 0 || !vendorUsageEndpointSupported(data.vendor);
      return {
        vendor: data.vendor,
        ...(account?.accountLabel
          ? { accountLabel: account.accountLabel }
          : {}),
        windows: hasFreshUsage
          ? polledWindows
          : cached?.vendor === data.vendor
            ? cached.windows
            : [],
        ...(hasFreshUsage
          ? { observedAt: Math.floor(Date.now() / 1_000) }
          : cached?.observedAt
            ? { observedAt: cached.observedAt }
            : {}),
      };
    });
    this.onWebview("cukii/openVendorUsageDetails", async ({ data }) => {
      await vscode.commands.executeCommand(
        "cukii.openVendorUsageDetails",
        data,
      );
    });

    // A session that starts streaming or raises a permission prompt changes
    // the drawer's Active count and status chips without any panel list
    // change, so the sidebar has to be told; the registry only fires on a
    // transition, never once per stream frame.
    cukiiSessionAttention.onChange(() => {
      this.webviewProtocol.send(
        "cukii/openChatPanelsChanged",
        listOpenCukiiPanels(),
      );
    });

    this.onWebview("cukii/renameSession", async ({ data }) =>
      this.enqueueSessionRename(data.sessionId, async () => {
        const trimmed = data.title.trim();
        if (!trimmed) {
          return { ok: false };
        }
        const saved = await this.inProcessMessenger.externalRequest(
          "history/rename",
          { id: data.sessionId, title: trimmed },
        );
        if (!saved) return { ok: false };
        // The persistence boundary may have retained a concurrent manual title.
        // Reflect the effective value, never the stale requested value.
        const effectiveTitle = saved.title;
        syncCukiiPanelTitleForSession(data.sessionId, effectiveTitle);
        const titlePayload = {
          sessionId: data.sessionId,
          title: effectiveTitle,
          titleManuallySet: Boolean(saved.titleManuallySet),
          revision: saved.revision,
        };
        for (const entry of cukiiPanelRegistry.values()) {
          entry.panel.protocol.send("cukii/sessionTitleChanged", titlePayload);
        }
        this.webviewProtocol.send("cukii/sessionTitleChanged", titlePayload);
        this.webviewProtocol.send(
          "cukii/openChatPanelsChanged",
          listOpenCukiiPanels(),
        );
        return {
          ok: true,
          title: effectiveTitle,
          titleManuallySet: Boolean(saved.titleManuallySet),
          revision: saved.revision,
        };
      }),
    );

    this.onWebview("acceptDiff", async ({ data: { filepath, streamId } }) => {
      await vscode.commands.executeCommand(
        "continue.acceptDiff",
        filepath,
        streamId,
      );
    });

    this.onWebview("rejectDiff", async ({ data: { filepath, streamId } }) => {
      await vscode.commands.executeCommand(
        "continue.rejectDiff",
        filepath,
        streamId,
      );
    });

    this.onWebview("applyToFile", async (message) => {
      const { data } = message;
      const [verticalDiffManager, configHandler] = await Promise.all([
        verticalDiffManagerPromise,
        configHandlerPromise,
      ]);

      const applyManager = new ApplyManager(
        this.ide,
        sourceProtocol(message, webviewProtocol),
        verticalDiffManager,
        configHandler,
      );

      await applyManager.applyToFile(data);
    });

    this.onWebview("showTutorial", async (msg) => {
      await showTutorial(this.ide);
    });

    this.onWebview(
      "overwriteFile",
      async ({ data: { prevFileContent, filepath } }) => {
        if (prevFileContent === null) {
          // TODO: Delete the file
          return;
        }

        await this.ide.openFile(filepath);

        // Get active text editor
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
          vscode.window.showErrorMessage("No active editor to apply edits to");
          return;
        }

        editor.edit((builder) =>
          builder.replace(
            new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length),
            ),
            prevFileContent,
          ),
        );
      },
    );

    this.onWebview("insertAtCursor", async (msg) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || !editor.selection) {
        return;
      }

      editor.edit((editBuilder) => {
        editBuilder.replace(
          new vscode.Range(editor.selection.start, editor.selection.end),
          msg.data.text,
        );
      });
    });
    this.onWebview("edit/addCurrentSelection", async (msg) => {
      const verticalDiffManager = await this.verticalDiffManagerPromise;
      await addCurrentSelectionToEdit({
        args: undefined,
        editDecorationManager,
        webviewProtocol: sourceProtocol(msg, this.webviewProtocol),
        verticalDiffManager,
      });
    });
    this.onWebview("edit/sendPrompt", async (msg) => {
      const prompt = msg.data.prompt;
      const { start, end } = msg.data.range.range;
      const verticalDiffManager = await verticalDiffManagerPromise;

      const configHandler = await configHandlerPromise;
      const { config } = await configHandler.loadConfig();

      if (!config) {
        throw new Error("Edit: Failed to load config");
      }

      const model =
        config?.selectedModelByRole.edit ?? config?.selectedModelByRole.chat;

      if (!model) {
        throw new Error("No Edit or Chat model selected");
      }

      const fileAfterEdit = await verticalDiffManager.streamEdit({
        input: stripImages(prompt),
        llm: model,
        streamId: EDIT_MODE_STREAM_ID,
        range: new vscode.Range(
          new vscode.Position(start.line, start.character),
          new vscode.Position(end.line, end.character),
        ),
        rulesToInclude: config.rules,
        isApply: false,
      });

      // Log dev data
      await DataLogger.getInstance().logDevData({
        name: "editInteraction",
        data: {
          prompt: stripImages(prompt),
          completion: fileAfterEdit ?? "",
          modelProvider: model.underlyingProviderName,
          modelName: model.title ?? "",
          modelTitle: model.title ?? "",
          filepath: msg.data.range.filepath,
        },
      });

      return fileAfterEdit;
    });

    this.onWebview("edit/clearDecorations", async (msg) => {
      editDecorationManager.clear();
    });

    this.onWebview("session/share", async (msg) => {
      await vscode.commands.executeCommand(
        "continue.shareSession",
        msg.data.sessionId,
      );
    });

    /** PASS THROUGH FROM WEBVIEW TO CORE AND BACK **/
    WEBVIEW_TO_CORE_PASS_THROUGH.filter(
      (messageType) => messageType !== "history/save",
    ).forEach((messageType) => {
      this.onWebview(messageType, async (msg) => {
        return await this.inProcessMessenger.externalRequest(
          messageType,
          msg.data,
          msg.messageId,
        );
      });
    });

    this.onWebview("history/save", async (msg) => {
      const result = await this.inProcessMessenger.externalRequest(
        "history/save",
        msg.data,
        msg.messageId,
      );
      // HistoryManager.save is the sole CAS/merge boundary and returns the
      // effective session, including a manual title or newer history that a
      // stale auto-title request was not allowed to overwrite.
      const session = result;
      if (session.sessionId && session.title) {
        syncCukiiPanelTitleForSession(session.sessionId, session.title);
        this.webviewProtocol.send(
          "cukii/openChatPanelsChanged",
          listOpenCukiiPanels(),
        );
      }
      return result;
    });

    /** PASS THROUGH FROM CORE TO WEBVIEW AND BACK **/
    CORE_TO_WEBVIEW_PASS_THROUGH.forEach((messageType) => {
      this.onCore(messageType, async (msg) => {
        const target = cukiiPanelRegistry.lastActive()?.panel.protocol;
        if (!target) {
          return undefined as any;
        }
        return target.request(messageType, msg.data);
      });
    });

    /** CORE ONLY LISTENERS **/
    // None right now

    /** BOTH CORE AND WEBVIEW **/
    this.onWebviewOrCore("readRangeInFile", async (msg) => {
      return await vscode.workspace
        .openTextDocument(msg.data.filepath)
        .then((document) => {
          const start = new vscode.Position(0, 0);
          const end = new vscode.Position(5, 0);
          const range = new vscode.Range(start, end);

          const contents = document.getText(range);
          return contents;
        });
    });

    this.onWebviewOrCore("getIdeSettings", async (msg) => {
      return ide.getIdeSettings();
    });
    this.onWebviewOrCore("getDiff", async (msg) => {
      return ide.getDiff(msg.data.includeUnstaged);
    });
    this.onWebviewOrCore("getTerminalContents", async (msg) => {
      return ide.getTerminalContents();
    });
    this.onWebviewOrCore("getDebugLocals", async (msg) => {
      return ide.getDebugLocals(Number(msg.data.threadIndex));
    });
    this.onWebviewOrCore("getAvailableThreads", async (msg) => {
      return ide.getAvailableThreads();
    });
    this.onWebviewOrCore("getTopLevelCallStackSources", async (msg) => {
      return ide.getTopLevelCallStackSources(
        msg.data.threadIndex,
        msg.data.stackDepth,
      );
    });
    this.onWebviewOrCore("getWorkspaceDirs", async (msg) => {
      return ide.getWorkspaceDirs();
    });
    this.onWebviewOrCore("writeFile", async (msg) => {
      return ide.writeFile(msg.data.path, msg.data.contents);
    });
    this.onWebviewOrCore("showVirtualFile", async (msg) => {
      return ide.showVirtualFile(msg.data.name, msg.data.content);
    });
    this.onWebviewOrCore("openFile", async (msg) => {
      return ide.openFile(msg.data.path);
    });
    this.onWebviewOrCore("runCommand", async (msg) => {
      await ide.runCommand(msg.data.command);
    });
    this.onWebview("cukii/openBridgeSession", async (msg) => {
      await vscode.commands.executeCommand(
        "cukii.openBridgeSession",
        msg.data.agent,
      );
    });
    // Published once as the messenger is built, so the harness has a value from
    // the first window rather than only after the owner first moves the toggle.
    this.publishAutocompact(
      this.context.globalState.get<BrokerAutocompact>(
        "cukii.brokerAutocompact",
        "50",
      ),
    );
    this.onWebview("cukii/getBrokerPreferences", () => ({
      brokerModel: this.context.globalState.get<BrokerModel>(
        "cukii.brokerModel",
        CUKII_DEFAULT_BROKER_MODEL,
      ),
      brokerSubagent: this.context.globalState.get<BrokerSubagent>(
        "cukii.brokerSubagent",
        "auto",
      ),
      brokerEffort: this.context.globalState.get<BrokerEffort>(
        "cukii.brokerEffort",
        "high",
      ),
      brokerSpeed: this.context.globalState.get<BrokerSpeed>(
        "cukii.brokerSpeed",
        "standard",
      ),
      brokerAutocompact: this.context.globalState.get<BrokerAutocompact>(
        "cukii.brokerAutocompact",
        "50",
      ),
      thinkingEnabled: this.context.globalState.get<boolean>(
        "cukii.thinkingEnabled",
        true,
      ),
      brokerPermissionMode: (() => {
        const stored = this.context.globalState.get<
          CukiiPermissionMode | boolean
        >("cukii.brokerPermissionMode");
        return stored === undefined
          ? "bypass"
          : coerceStoredPermissionMode(
              stored,
              this.context.globalState.get<boolean>(
                "cukii.allowAllPermissions",
                false,
              ),
            );
      })(),
      mode: this.context.globalState.get<"chat" | "plan" | "agent" | "broker">(
        "cukii.brokerMode",
        "broker",
      ),
    }));
    this.onWebview("cukii/setBrokerPreferences", async (msg) => {
      await Promise.all([
        this.context.globalState.update(
          "cukii.brokerModel",
          msg.data.brokerModel,
        ),
        this.context.globalState.update(
          "cukii.brokerSubagent",
          msg.data.brokerSubagent,
        ),
        this.context.globalState.update(
          "cukii.brokerEffort",
          msg.data.brokerEffort,
        ),
        this.context.globalState.update(
          "cukii.brokerSpeed",
          msg.data.brokerSpeed,
        ),
        this.context.globalState.update(
          "cukii.brokerAutocompact",
          msg.data.brokerAutocompact,
        ),
        // Also published to disk: the machine's rotation hooks are separate
        // PowerShell processes and cannot read globalState.
        Promise.resolve(this.publishAutocompact(msg.data.brokerAutocompact)),
        this.context.globalState.update(
          "cukii.thinkingEnabled",
          msg.data.thinkingEnabled,
        ),
        ...(msg.data.brokerPermissionMode
          ? [
              this.context.globalState.update(
                "cukii.brokerPermissionMode",
                msg.data.brokerPermissionMode,
              ),
              this.context.globalState.update(
                "cukii.allowAllPermissions",
                msg.data.brokerPermissionMode === "bypass",
              ),
            ]
          : []),
        ...(msg.data.mode
          ? [this.context.globalState.update("cukii.brokerMode", msg.data.mode)]
          : []),
      ]);
    });
    this.onWebview("cukii/listPermissionCapabilities", async () => {
      const capabilities = await allVendorPermissionCapabilities();
      return Object.values(capabilities).map(
        ({ vendor, supportedModes, cliVersion }) => ({
          vendor,
          supportedModes,
          cliVersion,
        }),
      );
    });
    this.onWebview("cukii/getPermissionCapabilities", async ({ data }) => {
      return vendorPermissionCapabilities(data.vendor);
    });
    this.onWebview("cukii/listVendorAccounts", async () => {
      const [accounts, memory] = await Promise.all([
        listCukiiAccounts({ store: this.context.secrets }),
        memoryAccount.status(),
      ]);
      return [...accounts, memory];
    });
    this.onWebview("cukii/listBrokerModelCatalog", async () => {
      return listBrokerModelCatalog();
    });
    this.onWebview("cukii/getIssueReportCapability", async ({ data }) => {
      return issueReporter.capability(data?.force === true);
    });
    this.onWebview("cukii/prepareIssueReport", async ({ data }) => {
      return issueReporter.prepare(data.sessionId, data.brokerModel);
    });
    this.onWebview("cukii/pickIssueImages", async ({ data }) => {
      const remaining = Math.max(0, Math.min(3, Math.trunc(data.remaining)));
      if (remaining === 0) return [];
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: remaining > 1,
        openLabel: "Attach screenshots",
        title: "Attach screenshots to the Cukii Chat issue report",
        filters: { Images: ["png", "jpg", "jpeg", "webp", "gif"] },
      });
      return issueReporter.registerPickedImages(
        (picked ?? []).slice(0, remaining).map((uri) => uri.fsPath),
      );
    });
    this.onWebview("cukii/registerIssueClipboardImages", async ({ data }) =>
      issueReporter.registerClipboardImages(data.images),
    );
    this.onWebview("cukii/releaseIssueImages", ({ data }) => {
      issueReporter.releasePickedImages(data.attachmentIds);
    });
    this.onWebview(
      "cukii/submitIssueReport",
      async ({ data }): Promise<CukiiIssueReportReceipt> =>
        issueReporter.submit(data),
    );
    this.onWebview("cukii/pickAttachmentFiles", async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: "Upload",
        title: "Upload files to Cukii Chat",
      });
      return (picked ?? []).map((uri) => ({
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).at(-1) ?? uri.fsPath,
      }));
    });
    this.onWebview("cukii/startVoiceRecording", async (msg) => {
      return await startVoiceRecording(msg.data.recordingId);
    });
    this.onWebview("cukii/stopVoiceRecording", async (msg) => {
      const language = resolveWhisperTranscribeLanguage({
        configured: vscode.workspace
          .getConfiguration("cukii")
          .get<string>("voiceLanguage"),
        vscodeLanguage: vscode.env.language,
      });
      return {
        text: await stopVoiceRecording(msg.data.recordingId, { language }),
      };
    });
    this.onWebview("cukii/cancelVoiceRecording", async (msg) => {
      await cancelVoiceRecording(msg.data.recordingId);
    });
    this.onWebview("cukii/voiceRecordingStatus", async (msg) =>
      voiceRecordingStatus(msg.data.recordingId),
    );
    this.onWebview("cukii/runVendorAuthAction", async (msg) => {
      clearBrokerVendorAccountCache();
      const action = msg.data.action as BrokerVendorAuthAction;
      if (isCukiiMemoryAccountId(msg.data.vendor)) {
        return memoryAccount.runAction(action, {
          promptEndpoint: (defaultValue) =>
            vscode.window.showInputBox({
              ignoreFocusOut: true,
              title: "Connect Cukii Box",
              prompt: "Cukii Box MCP endpoint",
              value: defaultValue,
              validateInput: (value) => {
                try {
                  new URL(value);
                  return undefined;
                } catch {
                  return "Enter a valid Cukii Box URL.";
                }
              },
            }),
          promptToken: () =>
            vscode.window.showInputBox({
              password: true,
              ignoreFocusOut: true,
              title: "Connect Cukii Box",
              prompt: "Access token",
            }),
        });
      }
      if (isYougileAccountId(msg.data.vendor)) {
        // Not a CLI account: no terminal is involved, so it returns before the
        // vendor terminal path below.
        return runYougileAuthAction(action, {
          store: this.context.secrets,
          host: {
            openExternal: (url) =>
              vscode.env.openExternal(vscode.Uri.parse(url)),
            readClipboard: () => vscode.env.clipboard.readText(),
            promptCredentials: async () => {
              const login = await vscode.window.showInputBox({
                ignoreFocusOut: true,
                title: "Sign in to YouGile",
                prompt: "Work email",
                placeHolder: "name@company.com",
                validateInput: (value) =>
                  value.trim() && value.includes("@")
                    ? undefined
                    : "Enter your YouGile email.",
              });
              if (!login) return undefined;
              const password = await vscode.window.showInputBox({
                password: true,
                ignoreFocusOut: true,
                title: "Sign in to YouGile",
                prompt: "Password",
              });
              return password ? { login, password } : undefined;
            },
            // After a sign-out, the key on this machine is still there. Offer
            // it rather than making the owner paste a key he already has — and
            // offer it, so entering a different account stays possible.
            confirmResume: async (account) => {
              const use = "Use it";
              const choice = await vscode.window.showInformationMessage(
                account
                  ? `Sign back in to YouGile with this machine's key (${account})?`
                  : "Sign back in to YouGile with this machine's key?",
                { modal: true },
                use,
                "Sign in with another account",
              );
              return choice === use;
            },
          },
        });
      }
      const vendor = msg.data.vendor as BrokerVendorId;
      if (vendor === "qwen" && (action === "login" || action === "logout")) {
        const result = await runAlibabaAuthAction(action, {
          host: {
            openExternal: (url) =>
              vscode.env.openExternal(vscode.Uri.parse(url)),
            readClipboard: () => vscode.env.clipboard.readText(),
            promptSecret: () =>
              vscode.window.showInputBox({
                password: true,
                ignoreFocusOut: true,
                title: "Sign in to Qwen (Alibaba Token Plan)",
                prompt:
                  "Paste the API key from the Alibaba Cloud console (starts with sk-)",
                placeHolder: "sk-…",
              }),
          },
        });
        if (result) return result;
      }
      // Codex device-auth prints a URL and a one-time code but never opens a
      // browser itself, and the terminal assist needed VS Code shell
      // integration (card 4139fac0). The managed spawn makes the browser and
      // clipboard assist unconditional; its output stays visible in a
      // dedicated Output channel.
      if (
        vendor === "codex" &&
        action === "login" &&
        deviceAuthLoginArgs(vendor)
      ) {
        // A second Log in click must not start a competing device flow that
        // overwrites the clipboard code and shares the output panel (M6b).
        if (this.codexLoginInFlight) {
          return {
            opened: true,
            message: "A Codex sign-in is already in progress in this window.",
          };
        }
        this.codexLoginInFlight = true;
        // Reuse one channel: VS Code persists Output panels under logs/, and
        // a fresh channel per login both accumulated duplicates and spread
        // the one-time code across more log files (Fable review MINOR-5).
        this.codexLoginOutput ??= vscode.window.createOutputChannel(
          "Cukii Chat · codex login",
        );
        const output = this.codexLoginOutput;
        output.clear();
        output.show(true);
        let observedCode: string | undefined;
        let managed: DeviceAuthLoginResult;
        try {
          managed = await runDeviceAuthLogin({
            vendor: "codex",
            host: {
              openExternal: async (url) => {
                await vscode.env.openExternal(vscode.Uri.parse(url));
              },
              writeClipboard: async (code) => {
                observedCode = code;
                await vscode.env.clipboard.writeText(code);
              },
            },
            onOutput: (chunk) =>
              output.append(
                observedCode
                  ? chunk.split(observedCode).join("[code copied to clipboard]")
                  : chunk,
              ),
            onChild: (child) => {
              this.codexLoginChildren.add(child);
              child.once("exit", () => this.codexLoginChildren.delete(child));
            },
          });
        } finally {
          this.codexLoginInFlight = false;
        }
        if (managed.outcome !== "unavailable") {
          clearBrokerVendorAccountCache();
          const notes: string[] = [];
          if (managed.assisted.includes("url")) {
            notes.push("The sign-in page opened in your browser.");
          }
          if (managed.assisted.includes("code")) {
            notes.push("The one-time code was copied to the clipboard.");
          }
          const summary =
            managed.outcome === "authenticated"
              ? "Signed in; the account status was refreshed."
              : managed.outcome === "timeout"
                ? "The sign-in flow timed out. Select Log in again."
                : "The sign-in flow finished without a completed browser confirmation. Check the Cukii codex login output, then select Log in again.";
          return {
            opened: true,
            message: [...notes, summary].join(" "),
          };
        }
      }
      const spec = vendorAuthTerminalCommand(vendor, action);
      if (!spec) {
        if (vendor === "kimi" && action === "logout") {
          // Silent logout: the CLI's only native logout is `/logout` inside
          // its interactive TUI, which spams the terminal with setup prompts
          // before the command even runs. Removing the native credentials is
          // the logout the account probe already trusts.
          const outcome = logoutNativeKimiAccount();
          clearBrokerVendorAccountCache();
          return {
            opened: true,
            message:
              outcome.removed > 0
                ? "Signed out; the account status was refreshed."
                : "No Kimi login was found on this machine.",
          };
        }
        return {
          opened: false,
          message:
            "This vendor does not expose that CLI authentication action.",
        };
      }
      if (
        action === "install" &&
        vendor !== "deepseek" &&
        spec.closesTerminal === true
      ) {
        const output = vscode.window.createOutputChannel(
          `Cukii Chat · ${vendor} install`,
        );
        output.clear();
        output.appendLine(
          `Installing ${vendor} without administrator rights...`,
        );
        output.show(true);
        const result = await runVendorInstallProcess(spec, {
          onOutput: (chunk) => output.append(chunk),
        });
        clearBrokerVendorAccountCache();
        const installed =
          result.exitCode === 0
            ? await vendorInstallTerminalOutcome(vendor)
            : "command-failed";
        if (installed === "transition") {
          output.appendLine("\nCukii: installation verified.");
          return {
            opened: true,
            message: "CLI installation completed and was verified.",
          };
        }

        const processResult = result.error
          ? result.error.message
          : result.signal
            ? `terminated by ${result.signal}`
            : `exited with code ${result.exitCode ?? "unknown"}`;
        output.appendLine(`\nCukii: installation failed (${processResult}).`);
        void vscode.window.showErrorMessage(
          `Cukii could not install ${vendor}: ${processResult}. The full installer output is open in the Output panel.`,
        );
        return {
          opened: true,
          message:
            "CLI installation failed. The full error is preserved in the Cukii installer output; fix it, then select Install again.",
        };
      }
      // Interactive login still runs the vendor's own npm shim. 2.0.132 left
      // that shim on PATH without the private Node, so `codex login` died in
      // `env: node: No such file or directory` (card 3d82899a) even after a
      // successful install. The wrapper written at install time covers a
      // fresh CLI; this env covers the already-installed shim and a vendor
      // that rewrites itself.
      const terminal = vscode.window.createTerminal({
        name: spec.name,
        env: vendorSpawnEnv(),
        ...(spec.shellPath
          ? { shellPath: spec.shellPath, shellArgs: spec.shellArgs }
          : {}),
      });
      terminal.show();
      // Stay pending until the native flow completes so the accounts button
      // keeps its loader instead of snapping back to the pre-action state.
      const flow = await this.runAuthTerminalFlow(
        terminal,
        spec,
        vendor,
        action,
      );
      clearBrokerVendorAccountCache();
      const notes: string[] = [];
      if (flow.assisted.includes("url")) {
        notes.push("The sign-in page opened in your browser.");
      }
      if (flow.assisted.includes("code")) {
        notes.push("The one-time code was copied to the clipboard.");
      }
      const summary =
        action === "install"
          ? flow.outcome === "command-failed"
            ? "CLI installation failed. Fix the error shown in the terminal, then select Install again."
            : flow.outcome === "terminal-closed" ||
                flow.outcome === "transition"
              ? "CLI installation finished in the integrated terminal."
              : "Latest CLI installation is running in the integrated terminal."
          : flow.outcome === "transition"
            ? action === "login"
              ? "Signed in; the account status was refreshed."
              : "Signed out; the account status was refreshed."
            : flow.outcome === "terminal-closed"
              ? "Authentication flow finished in the integrated terminal."
              : "Authentication flow is still running in the integrated terminal.";
      return {
        opened: true,
        message: [...notes, summary].join(" "),
      };
    });
    this.onWebview("cukii/respondClaudePermission", (msg) => {
      const protocol = sourceProtocol(msg, this.webviewProtocol);
      const accepted = [
        ...(this.claudePermissionBrokers.get(protocol) ?? []),
      ].some(({ broker }) => broker.respond(msg.data));
      // A forged or stale response must be silent and fail closed. In
      // particular, never relay it to a different panel's pending request.
      if (!accepted) return;
    });
    this.onWebview("cukii/respondUserQuestion", (msg) => {
      const protocol = sourceProtocol(msg, this.webviewProtocol);
      const accepted = [
        ...(this.bridgeRunCandidates.get(protocol)?.values() ?? []),
      ].some((run) => run.questionBroker.respond(msg.data));
      // Stale, forged and cross-panel answers fail closed.
      if (!accepted) return;
    });
    const disposePermissionBrokersFor = async (
      protocol: VsCodeWebviewProtocol,
      expectedStreamMessageId?: string,
    ) => {
      const runs = expectedStreamMessageId
        ? [
            this.bridgeCandidateFor(protocol, {
              streamMessageId: expectedStreamMessageId,
            }),
          ].filter((run): run is ActiveBridgeRun => Boolean(run))
        : [...(this.bridgeRunCandidates.get(protocol)?.values() ?? [])];
      if (expectedStreamMessageId && runs.length === 0) return;
      // Snapshot the brokers owned by the matched run before cancellation can
      // release the slot. A replacement Claude run may create a new broker
      // while the process tree is being reaped; the old abort must not dispose
      // that replacement's permission channel.
      const runIds = new Set(runs.map((run) => run.runId));
      const brokers = [
        ...(this.claudePermissionBrokers.get(protocol) ?? []),
      ].filter((owned) => !expectedStreamMessageId || runIds.has(owned.runId));
      let cancellationError: unknown;
      for (const run of runs) {
        run.questionBroker.dispose("run stopped");
        run.reactionBroker?.dispose();
        try {
          await this.cancelBridgeRun(protocol, run, `abort:${run.sessionId}`);
        } catch (error) {
          cancellationError ??= error;
        }
      }
      for (const { broker } of brokers) {
        // Stop/session replacement is an authority boundary: do not leave an
        // MCP worker waiting behind a closed chat or retain its private config.
        await broker.dispose();
        this.removePermissionBroker(protocol, broker);
      }
      if (cancellationError) throw cancellationError;
    };
    this.onWebview("abort", async (msg) => {
      await disposePermissionBrokersFor(
        sourceProtocol(msg, this.webviewProtocol),
        msg.messageId,
      );
    });
    this.onWebview("cukii/panelSessionChanged", async (msg) => {
      const protocol = sourceProtocol(msg, this.webviewProtocol);
      const previous = this.panelSessionIds.get(protocol);
      this.panelSessionIds.set(protocol, msg.data.sessionId);
      if (isRealPanelSessionTransition(previous, msg.data.sessionId)) {
        await disposePermissionBrokersFor(protocol);
        // The panel moved on; whatever the old session was waiting for is no
        // longer this tab's business and must not keep it in Active.
        if (previous) cukiiSessionAttention.forgetSession(previous);
      }
    });
    this.onWebview("cukii/streamBridgeChat", (msg) => {
      const protocol = sourceProtocol(msg, this.webviewProtocol);
      // Autocompact is kept per session, but the harness file is one per
      // machine. Republish here so it always describes the session that is
      // actually running: without this, two tabs on different shares left the
      // hooks on whichever tab last touched its preferences.
      if (msg.data.brokerAutocompact) {
        this.publishAutocompact(msg.data.brokerAutocompact);
      }
      const controller = new AbortController();
      const runId = msg.data.runId ?? `${Date.now()}-${++this.nextBridgeRunId}`;
      let resolveDone!: (result: CukiiBridgeRunCompletion) => void;
      const done = new Promise<CukiiBridgeRunCompletion>((resolve) => {
        resolveDone = resolve;
      });
      let terminationVerified = true;
      let childPid: number | undefined;
      const steering = new BridgeSteeringController(
        msg.data.sessionId,
        isClaudeNativeModel(msg.data.brokerModel),
      );
      const imageScope = new BridgeImageScope();
      const reactionTargetMessageId = [...msg.data.messages]
        .reverse()
        .find(
          (message): message is typeof message & { id: string } =>
            message.role === "user" &&
            typeof (message as { id?: unknown }).id === "string",
        )?.id;
      const reactionBroker =
        typeof reactionTargetMessageId === "string" &&
        reactionTargetMessageId.length > 0
          ? new BridgeReactionBroker(
              msg.data.sessionId,
              runId,
              reactionTargetMessageId,
              (reaction) =>
                protocol.send("cukii/userMessageReaction", reaction),
            )
          : undefined;
      // Every MCP-capable vendor pulls follow-ups from the same durable FIFO.
      // This includes Claude: native stdin can only surface a steer as a later
      // ordinary turn and has no inbox message id to acknowledge. The watch
      // turns the vendor's exact FIFO claim into the GUI read receipt.
      const inboxWatch = supportsBrokerInbox(msg.data.brokerModel)
        ? new BridgeInboxWatch(msg.data.sessionId, (messageId) => {
            reactionBroker?.setTargetMessage(messageId);
            protocol.send("cukii/steerInboxRead", {
              sessionId: msg.data.sessionId,
              messageId,
            });
          })
        : undefined;
      inboxWatch?.start();
      const cancellation = new BridgeRunCancellation(
        () => controller.abort(),
        done.then(() => undefined),
      );
      const run: ActiveBridgeRun = {
        runId,
        streamMessageId: msg.messageId,
        controller,
        done,
        sessionId: msg.data.sessionId,
        brokerModel: msg.data.brokerModel,
        steering,
        cancellation,
        imageScope,
        questionBroker: new BridgeQuestionBroker(
          msg.data.sessionId,
          runId,
          (request) => protocol.send("cukii/userQuestionRequested", request),
          undefined,
          (withdrawn) =>
            protocol.send("cukii/userQuestionWithdrawn", withdrawn),
        ),
        reactionBroker,
      };
      const permissionTransport: ClaudePermissionTransport = {
        panelId: this.panelIdForProtocol(protocol),
        sessionId: msg.data.sessionId,
        runId,
        onRequest: async (request) => {
          protocol.send("cukii/claudePermissionRequested", request);
        },
        onPendingChanged: (requestIds) =>
          cukiiSessionAttention.promptsChanged(msg.data.sessionId, requestIds),
        onBrokerCreated: (broker) =>
          this.addPermissionBroker(protocol, run.runId, broker),
        onBrokerDisposed: (broker) =>
          this.removePermissionBroker(protocol, broker),
        steering,
        onToolActivity: (event) => {
          recordCukiiDiagnostic(`bridge.tool.${event.kind}`, {
            sessionId: msg.data.sessionId,
            toolId: event.id,
          });
          if (event.kind === "start") cancellation.toolStarted(event.id);
          else cancellation.toolFinished(event.id);
        },
        onUsage: (windows) => {
          const vendor = brokerVendorForModel(msg.data.brokerModel);
          this.publishVendorUsage(vendor, windows);
        },
        // This is deliberately sent over the active extension/webview channel.
        // The local canary controller watches this iframe over CDP; a Remote-SSH
        // user-writable JSONL file is never accepted as runtime evidence.
        onRuntimeCanaryEvent: (event) => {
          protocol.send("cukii/runtimeCanaryAttestation", event);
        },
        onTerminationResult: (terminated) => {
          terminationVerified = terminated;
          recordCukiiDiagnostic("bridge.termination", {
            sessionId: msg.data.sessionId,
            terminated,
          });
        },
        onChildSpawned: (pid, binding) => {
          childPid = pid;
          recordCukiiDiagnostic("bridge.child.spawned", {
            sessionId: msg.data.sessionId,
            model: msg.data.brokerModel,
            pid,
          });
          // The coordinator reclaims zombie slots by probing this pid.
          run.childPid = pid;
          if (pid) run.questionBroker.bindVendorProcess(pid, binding);
          if (pid) run.reactionBroker?.bindVendorProcess(pid, binding);
        },
        imageScope,
        abortSignal: controller.signal,
      };
      this.registerBridgeCandidate(protocol, run);
      // If the owner submits a message during the small startup update window,
      // wait for the already-running package write to finish before spawning
      // the CLI. Registering the candidate first makes the updater stop before
      // the next vendor, so this wait is bounded by one installer rather than
      // the whole vendor list.
      const runVendor = brokerVendorForModel(msg.data.brokerModel);
      const vendorCliUpdateRun =
        this.vendorCliUpdating === runVendor
          ? this.vendorCliUpdateRun
          : undefined;
      run.questionBroker.start();
      run.reactionBroker?.start();
      const stream = (async function* () {
        await vendorCliUpdateRun;
        // Memory is additive and fail-open: an unavailable Box must not block
        // the vendor run, but a connected account is wired before the CLI is
        // spawned so its MCP child inherits the current direct edge binding.
        const memoryBinding = await memoryAccount
          .prepareForModel(msg.data.brokerModel)
          .catch((): CukiiMemoryLaunchBinding => ({ configured: false }));
        return yield* streamBridgeChat(
          {
            ...msg.data,
            // The bearer is inherited by the native process and its MCP child
            // only. It is never serialized into the transcript, command line,
            // or persistent vendor config.
            spawnEnv: memoryBinding.spawnEnv,
          },
          permissionTransport,
        );
      })();
      const messenger = this;
      const wrapped = (async function* () {
        try {
          const acquisition = await messenger.bridgeRuns.acquire(
            protocol,
            run,
            async (previous) => {
              try {
                await messenger.cancelBridgeRun(
                  protocol,
                  previous,
                  `replace:${previous.sessionId}:${run.runId}`,
                );
                return true;
              } catch {
                return false;
              }
            },
          );
          if (acquisition !== "acquired") {
            resolveDone({ terminationVerified: true, childPid });
            return {
              cukiiBridgeDisposition: acquisition,
              sessionId: run.sessionId,
              runId: run.runId,
            };
          }
          if (controller.signal.aborted) {
            messenger.bridgeRuns.release(protocol, run);
            resolveDone({ terminationVerified: true, childPid });
            return {
              cukiiBridgeDisposition: "superseded" as const,
              sessionId: run.sessionId,
              runId: run.runId,
            };
          }
          // From here the session is visibly working in the sidebar drawer. The
          // marker is dropped in `finally`, so an abort or a thrown stream frees
          // it just as a clean end does.
          cukiiSessionAttention.runStarted(run.sessionId, run.runId);
          recordCukiiDiagnostic("bridge.run.started", {
            sessionId: run.sessionId,
            model: run.brokerModel,
            runId: run.runId,
          });
          try {
            return yield* stream;
          } catch (error) {
            recordCukiiDiagnostic("bridge.run.failed", {
              sessionId: run.sessionId,
              model: run.brokerModel,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            cukiiSessionAttention.runEnded(run.sessionId, run.runId);
            recordCukiiDiagnostic("bridge.run.finished", {
              sessionId: run.sessionId,
              model: run.brokerModel,
              terminationVerified,
            });
            resolveDone({ terminationVerified, childPid });
            if (terminationVerified) {
              messenger.bridgeRuns.release(protocol, run);
            }
          }
        } finally {
          messenger.removeBridgeCandidate(protocol, run);
        }
      })();
      void done.finally(() => {
        steering.close();
        inboxWatch?.close();
        run.questionBroker.dispose("run finished");
        run.reactionBroker?.dispose();
        imageScope.dispose();
      });
      return wrapped;
    });
    this.onWebview(
      "cukii/steerDuringStream",
      async (msg): Promise<CukiiSteerReceipt> => {
        const protocol = sourceProtocol(msg, this.webviewProtocol);
        const run = this.bridgeRunForSteer(protocol, msg.data);
        if (!run) {
          return {
            messageId: msg.data.messageId,
            sessionId: msg.data.sessionId,
            status: "deferred",
          };
        }
        const usesBrokerInbox = supportsBrokerInbox(run.brokerModel);
        if (usesBrokerInbox) {
          // The agent claims this mid-run through broker_inbox. The durable GUI
          // outbox stays the fallback and dedups itself against the inbox read
          // mark at the turn boundary. Do not also inject the same payload via
          // Claude stdin: that path has no message id and would create a second
          // ordinary user turn after the acknowledged FIFO delivery.
          run.imageScope.persistInboxMessage(
            msg.data.content,
            (materializedContent, metadata) =>
              writeBridgeInboxMessageWithReceipt(
                run.sessionId,
                msg.data.messageId,
                materializedContent,
                metadata,
              ),
            { sessionId: run.sessionId, messageId: msg.data.messageId },
          );
          if (brokerVendorForModel(run.brokerModel) === "claude") {
            // Claude has no hook gate in its strict MCP config, and Opus kept
            // working through multi-minute tool chains without ever polling
            // (card c20375e9). Its stdin steering lands at the next tool
            // boundary, so a content-free hint there makes it poll the FIFO
            // now instead of at the end of the turn.
            run.steering.nudge(bridgeInboxNudgeText(msg.data.messageId));
          }
        }
        const receipt: CukiiSteerReceipt = usesBrokerInbox
          ? {
              messageId: msg.data.messageId,
              sessionId: msg.data.sessionId,
              status: "deferred",
            }
          : await run.steering.deliver(msg.data);
        if (receipt.status === "delivered") {
          run.reactionBroker?.setTargetMessage(msg.data.messageId);
        }
        return receipt;
      },
    );
    this.onWebview(
      "cukii/steerInboxReceipt",
      async (msg): Promise<CukiiInboxReceipt> => {
        return {
          sessionId: msg.data.sessionId,
          messageId: msg.data.messageId,
          status: bridgeInboxMessageStatus(
            msg.data.sessionId,
            msg.data.messageId,
          ),
        };
      },
    );
    this.onWebview(
      "cukii/cancelBridgeRun",
      async (msg): Promise<CukiiCancelReceipt> => {
        const protocol = sourceProtocol(msg, this.webviewProtocol);
        const run = this.bridgeCandidateFor(protocol, {
          runId: msg.data.runId,
        });
        if (
          !run ||
          run.sessionId !== msg.data.sessionId ||
          (msg.data.runId !== undefined && run.runId !== msg.data.runId)
        ) {
          return {
            requestId: msg.data.requestId,
            sessionId: msg.data.sessionId,
            runId: msg.data.runId,
            status: "already-cancelled",
            interrupted: "turn",
          };
        }
        const purge = purgeUnreadBridgeInboxMessages(msg.data.sessionId);
        // Explicit Stop cancels the queued bubbles on the GUI side; unread
        // inbox entries must die with them or the next run would resurrect
        // stale instructions the user already withdrew.
        const [receipt, purged] = await Promise.all([
          this.cancelBridgeRun(protocol, run, msg.data.requestId),
          purge,
        ]);
        if (!purged) {
          throw new Error(
            "Cukii cancelled the bridge run but could not retire its unread inbox messages",
          );
        }
        return receipt;
      },
    );
    this.onWebviewOrCore("getSearchResults", async (msg) => {
      return ide.getSearchResults(msg.data.query, msg.data.maxResults);
    });
    this.onWebviewOrCore("getFileResults", async (msg) => {
      return ide.getFileResults(msg.data.pattern, msg.data.maxResults);
    });
    this.onWebviewOrCore("subprocess", async (msg) => {
      return ide.subprocess(msg.data.command, msg.data.cwd);
    });
    this.onWebviewOrCore("getProblems", async (msg) => {
      return ide.getProblems(msg.data.filepath);
    });
    this.onWebviewOrCore("getBranch", async (msg) => {
      const { dir } = msg.data;
      return ide.getBranch(dir);
    });
    this.onWebviewOrCore("getOpenFiles", async (msg) => {
      return ide.getOpenFiles();
    });
    this.onWebviewOrCore("getCurrentFile", async () => {
      return ide.getCurrentFile();
    });
    this.onWebviewOrCore("getPinnedFiles", async (msg) => {
      return ide.getPinnedFiles();
    });
    this.onWebviewOrCore("showLines", async (msg) => {
      const { filepath, startLine, endLine } = msg.data;
      return ide.showLines(filepath, startLine, endLine);
    });
    this.onWebviewOrCore("showToast", (msg) => {
      this.ide.showToast(...msg.data);
    });
    this.onWebviewOrCore("saveFile", async (msg) => {
      return await ide.saveFile(msg.data.filepath);
    });
    this.onWebviewOrCore("readFile", async (msg) => {
      return await ide.readFile(msg.data.filepath);
    });
    this.onWebviewOrCore("openUrl", (msg) => {
      vscode.env.openExternal(vscode.Uri.parse(msg.data));
    });

    this.onWebviewOrCore("fileExists", async (msg) => {
      return await ide.fileExists(msg.data.filepath);
    });

    this.onWebviewOrCore("gotoDefinition", async (msg) => {
      return await ide.gotoDefinition(msg.data.location);
    });

    this.onWebviewOrCore("getReferences", async (msg) => {
      return await ide.getReferences(msg.data.location);
    });

    this.onWebviewOrCore("getDocumentSymbols", async (msg) => {
      return await ide.getDocumentSymbols(msg.data.textDocumentIdentifier);
    });

    this.onWebviewOrCore("getFileStats", async (msg) => {
      return await ide.getFileStats(msg.data.files);
    });

    this.onWebviewOrCore("getGitRootPath", async (msg) => {
      return await ide.getGitRootPath(msg.data.dir);
    });

    this.onWebviewOrCore("listDir", async (msg) => {
      return await ide.listDir(msg.data.dir);
    });

    this.onWebviewOrCore("getRepoName", async (msg) => {
      return await ide.getRepoName(msg.data.dir);
    });

    this.onWebviewOrCore("getTags", async (msg) => {
      return await ide.getTags(msg.data);
    });

    this.onWebviewOrCore("getIdeInfo", async (msg) => {
      return await ide.getIdeInfo();
    });

    this.onWebviewOrCore("isTelemetryEnabled", async (msg) => {
      return await ide.isTelemetryEnabled();
    });

    this.onWebviewOrCore("getUniqueId", async (msg) => {
      return await ide.getUniqueId();
    });

    this.onWebviewOrCore("reportError", async (msg) => {
      await handleLLMError(msg.data);
    });
  }
}
