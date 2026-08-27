import { ToIdeFromWebviewOrCoreProtocol } from "./ide";
import { ToWebviewFromIdeOrCoreProtocol } from "./webview";

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

export type BrokerModel =
  | "opus-5"
  | "sonnet-5"
  | "fable-5"
  | "codex-5-6-terra"
  | "codex-5-6-sol"
  | "grok-4-6"
  | "composer-2-5"
  | "kimi-k2"
  | "kimi-k3"
  | "deepseek-v4-pro"
  | "qwen-3-8-max";

export type BrokerSubagent = "auto" | BrokerModel;

export type CukiiOpenChatPanel = {
  panelId: string;
  sessionId?: string;
  title: string;
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
      mode?: "chat" | "plan" | "agent" | "broker";
    },
  ];
  "cukii/setBrokerPreferences": [
    {
      brokerModel: BrokerModel;
      brokerSubagent: BrokerSubagent;
      mode?: "chat" | "plan" | "agent" | "broker";
    },
    void,
  ];
  "cukii/streamBridgeChat": [
    {
      messages: ChatMessage[];
      brokerModel: BrokerModel;
      brokerSubagent: BrokerSubagent;
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
