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
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export type BrokerSpeed = "standard" | "fast";

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

export type BrokerVendorAuthStatus = {
  id: BrokerVendorId;
  label: string;
  state: "connected" | "disconnected" | "unavailable" | "postponed" | "unknown";
  /** Account identity shown below the vendor name. Never put transport/auth diagnostics here. */
  accountLabel: string;
  actions: BrokerVendorAuthAction[];
};

export type CukiiOpenChatPanel = {
  panelId: string;
  sessionId?: string;
  title: string;
};

export type CukiiPickedFile = {
  path: string;
  name: string;
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
      thinkingEnabled: boolean;
      mode?: "chat" | "plan" | "agent" | "broker";
    },
  ];
  "cukii/setBrokerPreferences": [
    {
      brokerModel: BrokerModel;
      brokerSubagent: BrokerSubagent;
      brokerEffort: BrokerEffort;
      brokerSpeed: BrokerSpeed;
      thinkingEnabled: boolean;
      mode?: "chat" | "plan" | "agent" | "broker";
    },
    void,
  ];
  "cukii/listVendorAccounts": [undefined, BrokerVendorAuthStatus[]];
  "cukii/listBrokerModelCatalog": [undefined, BrokerVendorModelCatalog[]];
  "cukii/pickAttachmentFiles": [undefined, CukiiPickedFile[]];
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
    { vendor: BrokerVendorId; action: BrokerVendorAuthAction },
    { opened: boolean; message: string },
  ];
  "cukii/streamBridgeChat": [
    {
      messages: ChatMessage[];
      brokerModel: BrokerModel;
      brokerSubagent: BrokerSubagent;
      brokerEffort: BrokerEffort;
      brokerSpeed: BrokerSpeed;
      thinkingEnabled: boolean;
    },
    AsyncGenerator<ChatMessage, PromptLog>,
  ];
  "cukii/steerDuringStream": [{ text: string }, boolean];
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
