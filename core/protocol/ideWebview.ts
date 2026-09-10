import { ToIdeFromWebviewOrCoreProtocol } from "./ide";
import { ToWebviewFromIdeOrCoreProtocol } from "./webview";
import type { BrokerVendorId } from "../cukiiVendorRegistry";
export type { BrokerVendorId } from "../cukiiVendorRegistry";

import {
  AcceptOrRejectDiffPayload,
  AddToChatPayload,
  ApplyState,
  ApplyToFilePayload,
  HighlightedCodePayload,
  MessageContent,
  ChatMessage,
  PromptLog,
  RangeInFileWithContents,
  SetCodeToEditPayload,
  ShowFilePayload,
} from "../";

/** Stable ids for built-ins plus vendor-prefixed ids discovered from live CLIs. */
export type BrokerModel = string;

export type BrokerSubagent = "auto" | BrokerModel;

export type BrokerEffort =
  "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type BrokerSpeed = "standard" | "fast";

/**
 * Share of the context window at which the thread auto-compacts.
 * "default" leaves the decision to the host/agent instead of forcing a share —
 * it is the only value the pill does not advertise.
 *
 * Owned by the plugin, not by the agent instructions: the rule used to live in
 * the agent contract, where every vendor had to restate it and they drifted.
 */
export type BrokerAutocompact = "25" | "50" | "75" | "default";

/** Picker scope: curated live routes only ("best") or the full catalog. */
export type BrokerModelScope = "best" | "all";

export type CukiiPermissionMode =
  "manual" | "editAutomatically" | "plan" | "auto" | "bypass";

export type BrokerVendorAuthAction = "install" | "login" | "logout";

export type BrokerModelCatalogEntry = {
  value: BrokerModel;
  label: string;
  contextWindowLabel: string;
  description?: string;
  disabled?: boolean;
};

export type BrokerVendorModelCatalog = {
  id: BrokerVendorId;
  label: string;
  models: BrokerModelCatalogEntry[];
};

/**
 * Accounts the plugin manages that are not model vendors. They share the whole
 * vendor row contract — probe, login, logout, account label — but never appear
 * in a model catalog, so they stay out of `BrokerVendorId`.
 */
export type BrokerToolAccountId = "yougile";

/** Section of the Accounts dialog a row belongs to. */
export type BrokerAccountGroup = "vendor" | "testing";

export type BrokerVendorAuthStatus = {
  id: BrokerVendorId | BrokerToolAccountId;
  label: string;
  /** Absent from an older host, which only ever sent model vendors. */
  group?: BrokerAccountGroup;
  /** Whether the vendor's native Windows CLI/product was found. */
  installed: boolean;
  /** Result of the current native CLI/local-auth probe. */
  authenticated: boolean;
  state: "connected" | "disconnected" | "unavailable" | "postponed" | "unknown";
  /** Account identity shown below the vendor name. Never put transport/auth diagnostics here. */
  accountLabel?: string;
  actions: BrokerVendorAuthAction[];
};

/**
 * What the host currently owes the user for one session.
 *
 * The sidebar and the panel that owns a session are two different webviews, so
 * the sidebar cannot read the panel's own store. Only the extension host sees
 * both the live bridge run and the outstanding permission prompts, so it is the
 * host that classifies a session — anything else would make the drawer's
 * "Active" count a guess.
 */
export type CukiiSessionAttention = "none" | "streaming" | "pending-permission";

export type CukiiOpenChatPanel = {
  panelId: string;
  sessionId?: string;
  title: string;
  /** Absent from an older host; the sidebar then reads the session as idle. */
  attention?: CukiiSessionAttention;
};

export type CukiiSteerReceipt = {
  messageId: string;
  sessionId: string;
  status: "delivered" | "deferred";
};

/** Read receipt of one broker-inbox entry; see bridgeInbox.ts on the host. */
export type CukiiInboxReceipt = {
  messageId: string;
  sessionId: string;
  status: "read" | "pending" | "absent";
};

export type CukiiCancelReceipt = {
  requestId: string;
  sessionId: string;
  status: "cancelled" | "already-cancelled";
  interrupted: "turn" | "tool";
  /** Teardown itself could not confirm death; a post-mortem pid liveness
   * probe did, so the run slot was released. */
  postMortem?: boolean;
};

/** Completion receipt of one native bridge run, consumed by the extension's
 * run coordinator. */
export type CukiiBridgeRunCompletion = {
  terminationVerified: boolean;
  /** Vendor child pid once the run reached spawn; undefined on spawn failure. */
  childPid?: number;
};

export type CukiiBridgeStreamDisposition = {
  cukiiBridgeDisposition: "superseded" | "blocked";
  sessionId: string;
  runId: string;
};

export type CukiiClaudePermissionRequest = {
  runId: string;
  requestId: string;
  sessionId: string;
  inputFingerprint: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
};

export type CukiiPickedFile = {
  path: string;
  name: string;
};

export type CukiiIssueSeverity = "blocker" | "major" | "minor" | "cosmetic";

export type CukiiIssueReportCapability = {
  available: boolean;
  reason:
    "available" | "not_authenticated" | "board_unavailable" | "unreachable";
  accountLabel?: string;
};

/** Opaque host-approved image. The webview never receives a filesystem path. */
export type CukiiIssuePickedImage = {
  id: string;
  name: string;
  size: number;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  previewDataUrl: string;
};

export type CukiiIssueClipboardImage = {
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  base64: string;
};

export type CukiiIssueDiagnosticsPreview = {
  extensionVersion: string;
  operatingSystem: string;
  remote: string;
  workspace: string[];
  sessionId: string;
  brokerModel: BrokerModel;
  logLines: string[];
};

export type CukiiIssueReportSubmission = {
  reportId: string;
  title: string;
  stepsToReproduce: string;
  expectedResult: string;
  actualResult: string;
  severity: CukiiIssueSeverity;
  sessionId: string;
  brokerModel: BrokerModel;
  attachmentIds: string[];
  snapshot?: {
    pngBase64: string;
    width: number;
    height: number;
    sanitizer: "cukii-report-v1";
  };
};

export type CukiiIssueReportReceipt = {
  reportId: string;
  status: "sent" | "queued";
  taskId?: string;
  taskUrl?: string;
  message: string;
};

export type ToIdeFromWebviewProtocol = ToIdeFromWebviewOrCoreProtocol & {
  openUrl: [string, void];
  applyToFile: [ApplyToFilePayload, void];
  overwriteFile: [{ filepath: string; prevFileContent: string | null }, void];
  showTutorial: [undefined, void];
  showFile: [ShowFilePayload, void];
  toggleDevTools: [undefined, void];
  reloadWindow: [undefined, void];
  focusEditor: [undefined, void];
  "cukii/getActiveEditorSelectionState": [undefined, { hasSelection: boolean }];
  toggleFullScreen: [{ newWindow?: boolean } | undefined, void];
  insertAtCursor: [{ text: string }, void];
  copyText: [{ text: string }, void];
  "cukii/openBridgeSession": [
    { agent: "deepseek" | "claude" | "codex" | "grok" | "cursor" | "qwen" },
    void,
  ];
  "cukii/delegateBridgeWorker": [{}, void];
  "cukii/getBrokerPreferences": [
    undefined,
    {
      brokerModel: BrokerModel;
      brokerSubagent: BrokerSubagent;
      brokerEffort: BrokerEffort;
      brokerSpeed: BrokerSpeed;
      brokerAutocompact: BrokerAutocompact;
      thinkingEnabled: boolean;
      brokerPermissionMode?: CukiiPermissionMode;
      mode?: "chat" | "plan" | "agent" | "broker";
    },
  ];
  "cukii/setBrokerPreferences": [
    {
      brokerModel: BrokerModel;
      brokerSubagent: BrokerSubagent;
      brokerEffort: BrokerEffort;
      brokerSpeed: BrokerSpeed;
      brokerAutocompact: BrokerAutocompact;
      thinkingEnabled: boolean;
      brokerPermissionMode?: CukiiPermissionMode;
      mode?: "chat" | "plan" | "agent" | "broker";
    },
    void,
  ];
  "cukii/listPermissionCapabilities": [
    undefined,
    {
      vendor: BrokerVendorId;
      supportedModes: CukiiPermissionMode[];
      cliVersion?: string;
    }[],
  ];
  /** Authoritative capability snapshot for exactly one selected vendor route. */
  "cukii/getPermissionCapabilities": [
    { vendor: BrokerVendorId },
    {
      vendor: BrokerVendorId;
      supportedModes: CukiiPermissionMode[];
      cliVersion?: string;
      route?: string;
      generation?: number;
      helpSource: string;
    },
  ];
  /** Reply to a native Claude permission request. The extension verifies the
   * originating webview, run, request and input fingerprint; this is never an
   * authority to alter the tool input. */
  "cukii/respondClaudePermission": [
    {
      runId: string;
      requestId: string;
      sessionId: string;
      inputFingerprint: string;
      decision: "allow" | "deny";
    },
    void,
  ];
  "cukii/listVendorAccounts": [undefined, BrokerVendorAuthStatus[]];
  "cukii/listBrokerModelCatalog": [undefined, BrokerVendorModelCatalog[]];
  "cukii/pickAttachmentFiles": [undefined, CukiiPickedFile[]];
  "cukii/getIssueReportCapability": [
    { force?: boolean } | undefined,
    CukiiIssueReportCapability,
  ];
  "cukii/prepareIssueReport": [
    { sessionId: string; brokerModel: BrokerModel },
    CukiiIssueDiagnosticsPreview,
  ];
  "cukii/pickIssueImages": [{ remaining: number }, CukiiIssuePickedImage[]];
  "cukii/registerIssueClipboardImages": [
    { images: CukiiIssueClipboardImage[] },
    CukiiIssuePickedImage[],
  ];
  "cukii/releaseIssueImages": [{ attachmentIds: string[] }, void];
  "cukii/submitIssueReport": [
    CukiiIssueReportSubmission,
    CukiiIssueReportReceipt,
  ];
  "cukii/startVoiceRecording": [
    { recordingId: string },
    { recordingId: string; device: string },
  ];
  "cukii/stopVoiceRecording": [{ recordingId: string }, { text: string }];
  "cukii/cancelVoiceRecording": [{ recordingId: string }, void];
  "cukii/voiceRecordingStatus": [
    { recordingId: string },
    {
      state: "starting" | "listening" | "expired" | "error" | "unknown";
      message?: string;
    },
  ];
  "cukii/runVendorAuthAction": [
    {
      vendor: BrokerVendorId | BrokerToolAccountId;
      action: BrokerVendorAuthAction;
    },
    { opened: boolean; message: string },
  ];
  "cukii/streamBridgeChat": [
    {
      sessionId: string;
      messages: ChatMessage[];
      brokerModel: BrokerModel;
      brokerSubagent: BrokerSubagent;
      brokerEffort: BrokerEffort;
      brokerSpeed: BrokerSpeed;
      brokerAutocompact: BrokerAutocompact;
      thinkingEnabled: boolean;
      brokerPermissionMode: CukiiPermissionMode;
      /**
       * Durable user follow-up being dispatched as this fresh vendor turn.
       * @deprecated Use queuedFollowUpMessageIds for batch delivery.
       */
      queuedFollowUpMessageId?: string;
      /** All durable follow-ups dispatched together in this fresh vendor turn. */
      queuedFollowUpMessageIds?: string[];
      /** The follow-up above interrupted an in-flight turn because the vendor
       * cannot accept live steering. The broker must resume the prior task. */
      steerInterrupt?: boolean;
    },
    AsyncGenerator<ChatMessage, PromptLog | CukiiBridgeStreamDisposition>,
  ];
  "cukii/steerDuringStream": [
    {
      messageId: string;
      sessionId: string;
      content: ChatMessage["content"];
      /** Optional on the wire; a missing identity is conservatively deferred. */
      brokerModel?: BrokerModel;
    },
    CukiiSteerReceipt,
  ];
  /** Drain dedup: was the queued bubble already claimed through broker_inbox? */
  "cukii/steerInboxReceipt": [
    { sessionId: string; messageId: string },
    CukiiInboxReceipt,
  ];
  "cukii/cancelBridgeRun": [
    { requestId: string; sessionId: string },
    CukiiCancelReceipt,
  ];
  "cukii/openChatPanel": [
    {
      panelId?: string;
      sessionId?: string;
      title?: string;
      forceNew?: boolean;
      suppressInitialChordCharacter?: boolean;
    },
    void,
  ];
  "cukii/listOpenChatPanels": [undefined, CukiiOpenChatPanel[]];
  "cukii/panelSessionChanged": [{ sessionId: string; title?: string }, void];
  /** The chat webview could not restore its requested saved session. */
  "cukii/initialSessionLoadFailed": [{ sessionId: string }, void];
  "cukii/renameSession": [
    { sessionId: string; title: string },
    {
      ok: boolean;
      title?: string;
      titleManuallySet?: boolean;
      revision?: number;
    },
  ];
  "jetbrains/isOSREnabled": [undefined, boolean];
  "jetbrains/onLoad": [
    undefined,
    {
      windowId: string;
      serverUrl: string;
      workspacePaths: string[];
      vscMachineId: string;
      vscMediaUrl: string;
    },
  ];
  "jetbrains/getColors": [undefined, Record<string, string | null | undefined>];
  "vscode/openMoveRightMarkdown": [undefined, void];
  acceptDiff: [AcceptOrRejectDiffPayload, void];
  rejectDiff: [AcceptOrRejectDiffPayload, void];
  "edit/sendPrompt": [
    {
      prompt: MessageContent;
      range: RangeInFileWithContents;
    },
    string | undefined,
  ];
  "edit/addCurrentSelection": [undefined, void];
  "edit/clearDecorations": [undefined, void];
  "session/share": [{ sessionId: string }, void];
};

export type ToWebviewFromIdeProtocol = ToWebviewFromIdeOrCoreProtocol & {
  setInactive: [undefined, void];
  newSessionWithPrompt: [{ prompt: string }, void];
  userInput: [{ input: string }, void];
  focusContinueInput: [undefined, void];
  focusContinueInputWithoutClear: [undefined, void];
  focusContinueInputWithNewSession: [undefined, void];
  highlightedCode: [HighlightedCodePayload, void];
  setCodeToEdit: [SetCodeToEditPayload, void];
  navigateTo: [{ path: string; toggle?: boolean }, void];
  addModel: [undefined, void];

  focusContinueSessionId: [{ sessionId: string | undefined }, void];
  newSession: [undefined, void];
  "cukii/getActiveSessionId": [undefined, string];
  "cukii/openChatPanelsChanged": [CukiiOpenChatPanel[], void];
  "cukii/activeEditorSelectionChanged": [{ hasSelection: boolean }, void];
  /** A real Claude `--permission-prompt-tool` request, scoped to this panel. */
  "cukii/claudePermissionRequested": [
    CukiiClaudePermissionRequest,
    { accepted: boolean },
  ];
  "cukii/sessionTitleChanged": [
    {
      sessionId: string;
      title: string;
      titleManuallySet?: boolean;
      revision?: number;
    },
    void,
  ];
  /** The vendor agent claimed the queued steer bubble through broker_inbox. */
  "cukii/steerInboxRead": [{ sessionId: string; messageId: string }, void];
  setTheme: [{ theme: any }, void];
  setColors: [{ [key: string]: string }, void];
  "jetbrains/editorInsetRefresh": [undefined, void];
  "jetbrains/isOSREnabled": [boolean, void];
  setupApiKey: [undefined, void];
  setupLocalConfig: [undefined, void];
  incrementFtc: [undefined, void];
  openOnboardingCard: [undefined, void];
  applyCodeFromChat: [undefined, void];
  updateApplyState: [ApplyState, void];
  exitEditMode: [undefined, void];
  focusEdit: [undefined, void];
  addToChat: [AddToChatPayload, void];
};
