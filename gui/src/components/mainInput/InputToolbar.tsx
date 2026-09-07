import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  ArrowUpIcon,
  DocumentPlusIcon,
  PencilIcon,
} from "@heroicons/react/24/outline";
import { InputModifiers } from "core";
import {
  brokerVendorForModel,
  resolvePermissionModeForVendor,
} from "core/cukiiPermissionModes";
import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectUseActiveFile } from "../../redux/selectors";
import {
  newSession,
  reconcileRestoredPermissionMode,
  setBrokerAutocompact,
  setBrokerEffort,
  setBrokerModel,
  switchBrokerModel,
  setBrokerModelScope,
  setBrokerPermissionMode,
  setBrokerSpeed,
  setBrokerSubagent,
  setHasReasoningEnabled,
} from "../../redux/slices/sessionSlice";
import type {
  BrokerAutocompact,
  BrokerEffort,
  BrokerModel,
  BrokerModelScope,
  BrokerSpeed,
  BrokerSubagent,
  CukiiPermissionMode,
} from "../../redux/slices/sessionSlice";
import type {
  BrokerVendorId,
  CukiiIssueReportCapability,
  CukiiPickedFile,
} from "core/protocol/ideWebview";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { exitEdit } from "../../redux/thunks/edit";
import { saveCurrentSession } from "../../redux/thunks/session";
import { isMetaEquivalentKeyPressed } from "../../util";
import { ToolTip } from "../gui/Tooltip";
import { ModelPickerModal } from "../modelSelection/ModelPickerModal";
import { ReportIssueModal } from "../reportIssue/ReportIssueModal";
import { VendorAccountsModal } from "../vendorAccounts/VendorAccountsModal";
import {
  displayModelLabel,
  EFFORT_LABELS,
  modelInfo,
  normalizeEffortForModel,
  supportsNativeSpeed,
  supportsNativeThinking,
} from "../modelSelection/vendors";
import { Button, Popover, PopoverButton, PopoverPanel } from "../ui";
import { useFontSize } from "../ui/font";
import { CukiiEffortRow } from "../cukii/CukiiEffortRow";
import {
  autocompactPillLabel,
  CukiiAutocompactRow,
} from "../cukii/CukiiAutocompactRow";
import { PermissionModeControl } from "./PermissionModeControl";

const ISSUE_CAPABILITY_REFRESH_MS = 60_000;

export interface ToolbarOptions {
  hideUseCodebase?: boolean;
  hideImageUpload?: boolean;
  hideAddContext?: boolean;
  enterText?: string;
  hideSelectModel?: boolean;
}

interface InputToolbarProps {
  onEnter?: (modifiers: InputModifiers) => void;
  onAddContextItem?: () => void;
  onFilesSelected?: (files: CukiiPickedFile[]) => void;
  onClick?: () => void;
  hidden?: boolean;
  activeKey: string | null;
  toolbarOptions?: ToolbarOptions;
  disabled?: boolean;
  isMainInput?: boolean;
  isInputEmpty?: boolean;
}

const menuItemClass =
  "cukii-menu-item flex w-full min-w-0 items-center justify-between gap-3 text-left text-[13px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:cursor-default disabled:opacity-45";

const commandSectionHeaderClass =
  "cukii-command-section-header px-3 pb-1 pt-2 text-xs font-normal leading-4 text-[var(--vscode-descriptionForeground)]";
const commandSectionDividerClass =
  "cukii-command-section-divider mx-0 my-1 border-0 border-t border-solid border-[var(--vscode-menu-separatorBackground)]";
const activeCommandItemClass =
  "cukii-command-menu-item-active bg-[var(--vscode-list-activeSelectionBackground)] text-[var(--vscode-list-activeSelectionForeground)]";

function CommandSectionHeader(props: { children: string; divided?: boolean }) {
  return (
    <>
      {props.divided && (
        <div
          aria-hidden="true"
          className={commandSectionDividerClass}
          data-testid="cukii-command-section-divider"
        />
      )}
      <div
        className={commandSectionHeaderClass}
        data-command-section={props.children}
      >
        {props.children}
      </div>
    </>
  );
}

function AddControlIcon() {
  return (
    <svg className="cukii-footer-icon" viewBox="0 0 20 20" fill="none">
      <path
        d="M10 5C10.2761 5 10.5 5.22386 10.5 5.5V9.5H14.5C14.7761 9.5 15 9.72386 15 10C15 10.2417 14.8286 10.4437 14.6006 10.4902L14.5 10.5H10.5V14.5C10.5 14.7761 10.2761 15 10 15C9.72386 15 9.5 14.7761 9.5 14.5V10.5H5.5L5.39941 10.4902C5.17145 10.4437 5 10.2417 5 10C5 9.75829 5.17145 9.55629 5.39941 9.50977L5.5 9.5H9.5V5.5C9.5 5.22386 9.72386 5 10 5Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CommandControlIcon() {
  return (
    <svg className="cukii-footer-icon" viewBox="0 0 20 20" fill="none">
      <path
        d="M14 4.5C14.8284 4.5 15.5 5.17157 15.5 6V14C15.5 14.8284 14.8284 15.5 14 15.5H6C5.17157 15.5 4.5 14.8284 4.5 14V6C4.5 5.17157 5.17157 4.5 6 4.5H14ZM6 5.5C5.72386 5.5 5.5 5.72386 5.5 6V14L5.50977 14.1006C5.55629 14.3286 5.75829 14.5 6 14.5H14L14.1006 14.4902C14.2961 14.4503 14.4503 14.2961 14.4902 14.1006L14.5 14V6C14.5 5.75829 14.3286 5.55629 14.1006 5.50977L14 5.5H6ZM11.0527 6.77734C11.1762 6.53042 11.4767 6.4294 11.7236 6.55273C11.9704 6.67627 12.0706 6.97676 11.9473 7.22363L8.94727 13.2236C8.82381 13.4701 8.52409 13.5701 8.27734 13.4473C8.03042 13.3238 7.9294 13.0233 8.05273 12.7764L11.0527 6.77734Z"
        fill="currentColor"
      />
    </svg>
  );
}

function InputToolbar(props: InputToolbarProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const useActiveFile = useAppSelector(selectUseActiveFile);
  const isInEdit = useAppSelector((state) => state.session.isInEdit);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const historyLength = useAppSelector((state) => state.session.history.length);
  const brokerModel = useAppSelector((state) => state.session.brokerModel);
  const sessionId = useAppSelector((state) => state.session.id);
  const brokerSubagent = useAppSelector(
    (state) => state.session.brokerSubagent,
  );
  const brokerEffort = useAppSelector((state) => state.session.brokerEffort);
  const brokerSpeed = useAppSelector((state) => state.session.brokerSpeed);
  const brokerAutocompact = useAppSelector(
    (state) => state.session.brokerAutocompact,
  );
  const brokerModelScope = useAppSelector(
    (state) => state.session.brokerModelScope ?? "best",
  );
  const hasReasoningEnabled = useAppSelector(
    (state) => state.session.hasReasoningEnabled,
  );
  const brokerPermissionMode = useAppSelector(
    (state) => state.session.brokerPermissionMode,
  );
  const codeToEdit = useAppSelector((state) => state.editModeState.codeToEdit);
  const restoredPanelDraft = useRef(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const selectedVendor = brokerVendorForModel(brokerModel ?? "qwen-3-8-max");
  const [permissionCapabilities, setPermissionCapabilities] = useState<{
    vendor: BrokerVendorId;
    supportedModes: CukiiPermissionMode[];
    route?: string;
    generation?: number;
  } | null>(null);
  const [vendorAccountsOpen, setVendorAccountsOpen] = useState(false);
  const [reportIssueOpen, setReportIssueOpen] = useState(false);
  const [issueCapability, setIssueCapability] =
    useState<CukiiIssueReportCapability>();
  const [reportIssueAvailableForOpenMenu, setReportIssueAvailableForOpenMenu] =
    useState(false);
  const issueCapabilityGeneration = useRef(0);
  const [actionQuery, setActionQuery] = useState("");
  const [activeCommandAction, setActiveCommandAction] = useState<string | null>(
    null,
  );
  const commandMenuRef = useRef<HTMLDivElement | null>(null);
  const commandMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const primaryActionsRef = useRef<HTMLDivElement | null>(null);
  const [modelPillOnOwnRow, setModelPillOnOwnRow] = useState(false);

  const refreshIssueCapability = useCallback(
    async (force = false) => {
      if (!props.isMainInput) return;
      const generation = ++issueCapabilityGeneration.current;
      try {
        const response = await ideMessenger.request(
          "cukii/getIssueReportCapability",
          { force },
        );
        if (
          generation === issueCapabilityGeneration.current &&
          response.status === "success"
        ) {
          setIssueCapability(response.content);
        }
      } catch {
        if (generation === issueCapabilityGeneration.current) {
          setIssueCapability({ available: false, reason: "unreachable" });
        }
      }
    },
    [ideMessenger, props.isMainInput],
  );

  useEffect(() => {
    void refreshIssueCapability();
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") {
        void refreshIssueCapability();
      }
    };
    const interval = window.setInterval(
      refreshWhenVisible,
      ISSUE_CAPABILITY_REFRESH_MS,
    );
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      issueCapabilityGeneration.current += 1;
    };
  }, [refreshIssueCapability]);

  useEffect(() => {
    let cancelled = false;
    setPermissionCapabilities(null);
    void ideMessenger
      .request("cukii/getPermissionCapabilities", { vendor: selectedVendor })
      .then((response) => {
        if (cancelled || response.status !== "success") return;
        if (response.content.vendor !== selectedVendor) return;
        setPermissionCapabilities(response.content);
      })
      .catch(() => {
        // Keep the current preference, but advertise no unverified mode.
      });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger, selectedVendor]);

  const updateBrokerPreferences = (
    nextModel: BrokerModel,
    nextSubagent: BrokerSubagent,
    nextEffort: BrokerEffort = brokerEffort,
    nextSpeed: BrokerSpeed = brokerSpeed,
    nextThinking: boolean = hasReasoningEnabled,
    nextAutocompact: BrokerAutocompact = brokerAutocompact,
    nextPermissionMode: CukiiPermissionMode = brokerPermissionMode,
  ) => {
    const resolvedEffort = normalizeEffortForModel(nextModel, nextEffort);
    const vendor = brokerVendorForModel(nextModel);
    const capability =
      permissionCapabilities?.vendor === vendor
        ? permissionCapabilities
        : undefined;
    // An empty snapshot means discovery failed, not that the vendor has no
    // modes: never resolve the user's intent down against it. Route dispatch
    // performs the same live probe before process creation.
    const verifiedCapability =
      capability && capability.supportedModes.length > 0
        ? capability
        : undefined;
    const targetCapabilities = {
      vendor,
      supportedModes: verifiedCapability?.supportedModes ?? [],
      helpSource: verifiedCapability ? "live" : "pending",
    };
    // While the probe is pending preserve intent without claiming support.
    const resolvedPermissionMode = !verifiedCapability
      ? nextPermissionMode
      : resolvePermissionModeForVendor(targetCapabilities, nextPermissionMode);
    dispatch(
      switchBrokerModel({
        model: nextModel,
        displayName: modelInfo(nextModel)?.label ?? nextModel,
      }),
    );
    dispatch(setBrokerSubagent(nextSubagent));
    dispatch(setBrokerEffort(resolvedEffort));
    dispatch(setBrokerSpeed(nextSpeed));
    dispatch(setBrokerAutocompact(nextAutocompact));
    dispatch(setHasReasoningEnabled(nextThinking));
    dispatch(setBrokerPermissionMode(resolvedPermissionMode));
    // VS Code webview state is scoped to this panel/tab. It deliberately
    // carries a blank-tab draft without writing history metadata or sharing
    // it through extension globalState with another blank tab.
    window.cukiiVscode?.setState({
      ...(window.cukiiVscode?.getState() ?? {}),
      cukiiBrokerDraft: {
        brokerModel: nextModel,
        brokerSubagent: nextSubagent,
        brokerEffort: resolvedEffort,
        brokerSpeed: nextSpeed,
        brokerAutocompact: nextAutocompact,
        brokerModelScope,
        thinkingEnabled: nextThinking,
        brokerPermissionMode: resolvedPermissionMode,
      },
    });
    if (historyLength > 0) {
      ideMessenger.post("cukii/setBrokerPreferences", {
        brokerModel: nextModel,
        brokerSubagent: nextSubagent,
        brokerEffort: resolvedEffort,
        brokerSpeed: nextSpeed,
        brokerAutocompact: nextAutocompact,
        thinkingEnabled: nextThinking,
        brokerPermissionMode: resolvedPermissionMode,
        mode: "broker",
      });
      void dispatch(
        saveCurrentSession({ openNewSession: false, generateTitle: false }),
      );
    }
  };

  useEffect(() => {
    if (restoredPanelDraft.current || historyLength > 0) return;
    restoredPanelDraft.current = true;
    const draft = window.cukiiVscode?.getState()?.cukiiBrokerDraft as
      | Partial<{
          brokerModel: BrokerModel;
          brokerSubagent: BrokerSubagent;
          brokerEffort: BrokerEffort;
          brokerSpeed: BrokerSpeed;
          brokerAutocompact: BrokerAutocompact;
          brokerModelScope: BrokerModelScope;
          thinkingEnabled: boolean;
          brokerPermissionMode: CukiiPermissionMode;
        }>
      | undefined;
    if (!draft) return;
    const restoredModel = draft.brokerModel ?? brokerModel ?? "opus-5";
    if (draft.brokerModel) dispatch(setBrokerModel(draft.brokerModel));
    if (draft.brokerSubagent) dispatch(setBrokerSubagent(draft.brokerSubagent));
    if (draft.brokerEffort) dispatch(setBrokerEffort(draft.brokerEffort));
    if (draft.brokerSpeed) dispatch(setBrokerSpeed(draft.brokerSpeed));
    if (draft.brokerAutocompact) {
      dispatch(setBrokerAutocompact(draft.brokerAutocompact));
    }
    if (draft.brokerModelScope === "all" || draft.brokerModelScope === "best") {
      dispatch(setBrokerModelScope(draft.brokerModelScope));
    }
    if (typeof draft.thinkingEnabled === "boolean") {
      dispatch(setHasReasoningEnabled(draft.thinkingEnabled));
    }
    if (draft.brokerPermissionMode) {
      const reconciled = reconcileRestoredPermissionMode(
        restoredModel,
        draft.brokerPermissionMode,
      );
      dispatch(setBrokerPermissionMode(reconciled));
      if (reconciled !== draft.brokerPermissionMode) {
        window.cukiiVscode?.setState({
          ...(window.cukiiVscode?.getState() ?? {}),
          cukiiBrokerDraft: { ...draft, brokerPermissionMode: reconciled },
        });
      }
    }
  }, [brokerModel, dispatch, historyLength]);

  const isEnterDisabled =
    !isStreaming && (props.disabled || (isInEdit && codeToEdit.length === 0));
  const isRetry = props.toolbarOptions?.enterText === "Retry";
  const showStop = isStreaming && (props.isInputEmpty ?? true);
  const currentModel = brokerModel ?? "opus-5";
  const currentModelInfo = modelInfo(currentModel);
  const currentLabel = currentModelInfo
    ? displayModelLabel(currentModelInfo)
    : "Opus 5 (1M)";
  const nativeFastAvailable = supportsNativeSpeed(currentModel);
  const nativeThinkingAvailable = supportsNativeThinking(currentModel);
  /**
   * Everything the pill says after the model name: effort, then "Fast" only
   * when the route actually has an accelerated tier and it is on, then the
   * autocompact share unless it is left at Default. Absent facts are dropped
   * rather than rendered as placeholders — a pill reading "Fast" when fast is
   * unavailable would be a lie, and "Default" adds nothing.
   */
  const pillDetail = [
    EFFORT_LABELS[normalizeEffortForModel(currentModel, brokerEffort)],
    nativeFastAvailable && brokerSpeed === "fast" ? "Fast" : "",
    autocompactPillLabel(brokerAutocompact),
  ]
    .filter(Boolean)
    .join(" ");

  // Claude moves the model pill to a dedicated row at its final fit stage.
  // Cukii's first implementation let the left group wrap but kept the right
  // controls vertically centred, so the two rows physically overlapped.  The
  // wrapped height is the reliable signal because labels/theme fonts vary.
  useLayoutEffect(() => {
    const actions = primaryActionsRef.current;
    if (!actions || isInEdit) {
      setModelPillOnOwnRow(false);
      return;
    }
    const update = () => {
      setModelPillOnOwnRow(actions.getBoundingClientRect().height > 30);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(actions);
    return () => observer.disconnect();
  }, [isInEdit, currentLabel, pillDetail]);

  const smallFont = useFontSize(-2);
  const showAction = (label: string) =>
    label.toLowerCase().includes(actionQuery.trim().toLowerCase());
  useEffect(() => setActiveCommandAction(null), [actionQuery]);
  const commandActionProps = (label: string) => ({
    "data-cukii-command-action": label,
    className: `${menuItemClass} cukii-command-menu-action ${activeCommandAction === label ? activeCommandItemClass : ""}`,
    onMouseEnter: () => setActiveCommandAction(label),
    onMouseLeave: (event: ReactMouseEvent<HTMLButtonElement>) => {
      if (document.activeElement !== event.currentTarget) {
        setActiveCommandAction(null);
      }
    },
    onFocus: () => setActiveCommandAction(label),
  });
  const onCommandMenuKeyDown = (event: ReactKeyboardEvent) => {
    const actions = [
      ...(commandMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-cukii-command-action]:not(:disabled)",
      ) ?? []),
    ];
    if ((event.key === "Enter" || event.key === " ") && activeCommandAction) {
      const active = actions.find(
        (item) => item.dataset.cukiiCommandAction === activeCommandAction,
      );
      if (active) {
        event.preventDefault();
        active.click();
      }
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!actions.length) return;
    event.preventDefault();
    const currentIndex = actions.findIndex(
      (item) => item.dataset.cukiiCommandAction === activeCommandAction,
    );
    const nextIndex =
      event.key === "ArrowDown"
        ? currentIndex < 0
          ? 0
          : (currentIndex + 1) % actions.length
        : currentIndex < 0
          ? actions.length - 1
          : (currentIndex - 1 + actions.length) % actions.length;
    actions[nextIndex].focus();
  };

  const pickFiles = async () => {
    const result = await ideMessenger.request(
      "cukii/pickAttachmentFiles",
      undefined,
    );
    if (result.status === "success" && result.content.length > 0) {
      props.onFilesSelected?.(result.content);
    }
  };

  return (
    <>
      <div
        onClick={props.onClick}
        className={`cukii-input-footer find-widget-skip flex min-w-0 select-none items-center justify-between gap-2 border-t border-[var(--vscode-panel-border)] px-2 pb-1 pt-2 ${
          modelPillOnOwnRow ? "cukii-input-footer--model-row" : ""
        } ${
          props.hidden
            ? "pointer-events-none h-0 opacity-0"
            : "pointer-events-auto mt-2 opacity-100"
        }`}
        style={{ fontSize: smallFont }}
      >
        {/* Claude fit-stage parity: controls never overlap — the pill wraps
            to its own line inside the left group when the width runs out. */}
        <div
          ref={primaryActionsRef}
          className="cukii-footer-primary-actions flex min-w-0 flex-1 flex-wrap items-center gap-1 gap-y-[3px]"
        >
          {!isInEdit && (
            <Popover className="relative">
              <PopoverButton
                data-testid="cukii-attach-menu-button"
                className="cukii-icon-button flex items-center justify-center rounded text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                aria-label="Attach"
                title="Add"
              >
                <AddControlIcon />
              </PopoverButton>
              <PopoverPanel className="cukii-menu-surface absolute bottom-full left-0 z-[1000] mb-2 w-64 rounded-md border border-[var(--vscode-widget-border)] bg-[var(--vscode-menu-background)] p-1 shadow-xl">
                {({ close }) => (
                  <>
                    <button
                      className={menuItemClass}
                      type="button"
                      onClick={() => {
                        close();
                        void pickFiles();
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <ArrowUpTrayIcon className="h-[17px] w-[17px]" /> Upload
                        from computer
                      </span>
                    </button>
                    <button
                      className={menuItemClass}
                      type="button"
                      onClick={() => {
                        close();
                        props.onAddContextItem?.();
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <DocumentPlusIcon className="h-[17px] w-[17px]" /> Add
                        context
                      </span>
                    </button>
                  </>
                )}
              </PopoverPanel>
            </Popover>
          )}

          {!isInEdit && (
            <Popover className="relative">
              <PopoverButton
                ref={commandMenuButtonRef}
                data-testid="broker-menu-button"
                onClick={() => {
                  setActionQuery("");
                  setActiveCommandAction(null);
                  // Freeze membership for this opening. Capability probes run
                  // ahead of the interaction and replace state atomically; an
                  // async response must never insert/remove a row underneath
                  // the pointer while the menu is already open.
                  setReportIssueAvailableForOpenMenu(
                    issueCapability?.available === true,
                  );
                }}
                className="cukii-icon-button flex items-center justify-center rounded text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                aria-label="Commands and model"
                title="Show command menu (/)"
              >
                <CommandControlIcon />
              </PopoverButton>
              <PopoverPanel className="cukii-command-menu cukii-menu-surface absolute bottom-full left-[-28px] z-[1000] mb-2 max-h-[min(62vh,520px)] overflow-y-auto overflow-x-hidden rounded-md border border-[var(--vscode-widget-border)] bg-[var(--vscode-menu-background)] p-1 shadow-2xl">
                {({ close }) => (
                  <div
                    ref={commandMenuRef}
                    data-testid="cukii-slash-menu"
                    onKeyDown={onCommandMenuKeyDown}
                  >
                    <div className="sticky top-0 z-10 bg-[var(--vscode-menu-background)] p-1">
                      <input
                        autoFocus
                        value={actionQuery}
                        onChange={(event) => setActionQuery(event.target.value)}
                        placeholder="Filter actions..."
                        className="cukii-menu-filter w-full rounded border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] px-3 py-2 text-[13px] text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
                      />
                    </div>
                    <CommandSectionHeader>Context</CommandSectionHeader>
                    {showAction("Attach file") && (
                      <button
                        {...commandActionProps("Attach file")}
                        type="button"
                        onClick={() => {
                          close();
                          void pickFiles();
                        }}
                      >
                        Attach file…
                      </button>
                    )}
                    {showAction("Mention file from this project") && (
                      <button
                        {...commandActionProps(
                          "Mention file from this project",
                        )}
                        type="button"
                        onClick={() => {
                          close();
                          props.onAddContextItem?.();
                        }}
                      >
                        Mention file from this project…
                      </button>
                    )}
                    {showAction("Clear conversation") && (
                      <button
                        {...commandActionProps("Clear conversation")}
                        type="button"
                        onClick={() => {
                          close();
                          dispatch(newSession());
                        }}
                      >
                        Clear conversation
                      </button>
                    )}
                    <CommandSectionHeader divided>Model</CommandSectionHeader>
                    {showAction("Switch model") && (
                      <button
                        data-testid="broker-switch-model"
                        {...commandActionProps("Switch model")}
                        type="button"
                        onClick={() => {
                          close();
                          setModelPickerOpen(true);
                        }}
                      >
                        <span className="min-w-0 truncate">Switch model…</span>
                        <span className="min-w-0 shrink truncate text-[var(--vscode-descriptionForeground)]">
                          {currentLabel}
                        </span>
                      </button>
                    )}
                    {showAction("Autocompact") && (
                      <CukiiAutocompactRow
                        className={menuItemClass}
                        autocompact={brokerAutocompact}
                        onAutocompactChange={(nextAutocompact) =>
                          updateBrokerPreferences(
                            currentModel,
                            brokerSubagent ?? "auto",
                            brokerEffort,
                            brokerSpeed,
                            undefined,
                            nextAutocompact,
                          )
                        }
                      />
                    )}
                    {showAction("Effort") && (
                      <CukiiEffortRow
                        className={`${menuItemClass} cukii-effort-menu-row`}
                        model={currentModel}
                        effort={brokerEffort}
                        onEffortChange={(nextEffort) =>
                          updateBrokerPreferences(
                            currentModel,
                            brokerSubagent ?? "auto",
                            nextEffort,
                            brokerSpeed,
                          )
                        }
                      />
                    )}
                    {nativeThinkingAvailable && showAction("Thinking") && (
                      <button
                        data-testid="cukii-thinking-toggle"
                        {...commandActionProps("Thinking")}
                        type="button"
                        role="switch"
                        aria-checked={hasReasoningEnabled}
                        title="Enable or disable the vendor's native reasoning mode"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          updateBrokerPreferences(
                            currentModel,
                            brokerSubagent ?? "auto",
                            brokerEffort,
                            brokerSpeed,
                            !hasReasoningEnabled,
                          );
                        }}
                      >
                        <span>Thinking</span>
                        <span
                          data-testid="cukii-thinking-track"
                          className={`cukii-toggle-track ${hasReasoningEnabled ? "cukii-toggle-track-on" : ""}`}
                        >
                          <span className="cukii-toggle-thumb" />
                        </span>
                      </button>
                    )}
                    {/* A route without a native accelerated tier shows no row
                        at all instead of a permanently disabled one. */}
                    {nativeFastAvailable && showAction("Fast mode") && (
                      <button
                        data-testid="cukii-speed-toggle"
                        {...commandActionProps("Fast mode")}
                        type="button"
                        role="switch"
                        aria-checked={brokerSpeed === "fast"}
                        title="Use the vendor's native accelerated service tier"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          updateBrokerPreferences(
                            currentModel,
                            brokerSubagent ?? "auto",
                            brokerEffort,
                            brokerSpeed === "fast" ? "standard" : "fast",
                          );
                        }}
                      >
                        <span>Fast mode</span>
                        <span
                          data-testid="cukii-speed-track"
                          className={`cukii-toggle-track ${brokerSpeed === "fast" ? "cukii-toggle-track-on" : ""}`}
                        >
                          <span className="cukii-toggle-thumb" />
                        </span>
                      </button>
                    )}
                    {showAction("Manage accounts") && (
                      <button
                        {...commandActionProps("Manage accounts")}
                        type="button"
                        onClick={() => {
                          close();
                          setVendorAccountsOpen(true);
                        }}
                      >
                        Manage accounts…
                      </button>
                    )}
                    {props.isMainInput &&
                      reportIssueAvailableForOpenMenu &&
                      showAction("Report an issue") && (
                        <button
                          data-testid="cukii-report-issue-menu-item"
                          {...commandActionProps("Report an issue")}
                          type="button"
                          onClick={(event) => {
                            // The toolbar lives inside InputBoxDiv, whose click
                            // handler focuses TipTap. Letting this command click
                            // bubble schedules a requestAnimationFrame focus
                            // after the modal has focused Title, so native
                            // selects instantly close and text fields blur.
                            event.preventDefault();
                            event.stopPropagation();
                            close();
                            setReportIssueOpen(true);
                          }}
                        >
                          Report an issue…
                        </button>
                      )}
                  </div>
                )}
              </PopoverPanel>
            </Popover>
          )}

          {/* MAX/Claude-style model pill rides right next to the "/" command
              control; it opens the same picker as "Switch model…". */}
          {!isInEdit && (
            <button
              type="button"
              data-testid="cukii-model-pill"
              /* Geometry measured on the live Claude Code pill
                 (.modelPill_gGYT1w): 18px tall, 11.05px text, 0 8px padding,
                 4px between the name and the dimmed detail. Ours was 26px /
                 13px / 16px — a visibly heavier capsule than the reference. */
              className="cukii-model-pill flex h-[18px] max-w-[280px] shrink-0 items-center gap-1 rounded-full px-2 text-[11.05px] leading-[18px] text-[var(--vscode-foreground)]"
              title={`Model: ${currentLabel}${pillDetail ? ` · ${pillDetail}` : ""}. Click to switch`}
              aria-label={`Selected model: ${currentLabel}${pillDetail ? `, ${pillDetail}` : ""}`}
              onClick={() => setModelPickerOpen(true)}
            >
              {/* Model name carries the foreground colour; everything after it
                  is a detail and stays muted, the way the reference client
                  renders its own pill. */}
              <span className="min-w-0 truncate">{currentLabel}</span>
              {pillDetail && (
                <span
                  data-testid="cukii-model-pill-detail"
                  className="shrink-0 whitespace-nowrap text-[var(--vscode-descriptionForeground)]"
                >
                  {pillDetail}
                </span>
              )}
            </button>
          )}

          {isInEdit && (
            <button
              className={menuItemClass}
              type="button"
              onClick={() => {
                void dispatch(exitEdit({}));
                ideMessenger.post("focusEditor", undefined);
              }}
            >
              Esc to exit Edit
            </button>
          )}
        </div>

        <div className="cukii-footer-secondary-actions flex shrink-0 items-center gap-2">
          {!isInEdit && (
            <PermissionModeControl
              brokerModel={currentModel}
              permissionMode={brokerPermissionMode}
              effort={brokerEffort}
              onChange={(mode) => {
                updateBrokerPreferences(
                  currentModel,
                  brokerSubagent ?? "auto",
                  brokerEffort,
                  brokerSpeed,
                  hasReasoningEnabled,
                  brokerAutocompact,
                  mode,
                );
              }}
              onEffortChange={(effort) => {
                updateBrokerPreferences(
                  currentModel,
                  brokerSubagent ?? "auto",
                  effort,
                  brokerSpeed,
                  hasReasoningEnabled,
                  brokerAutocompact,
                  brokerPermissionMode,
                );
              }}
            />
          )}

          <ToolTip
            place="top"
            content={showStop ? "Stop response" : "Send message"}
          >
            <Button
              variant={props.isMainInput ? "primary" : "secondary"}
              size="sm"
              className={`cukii-submit-button cukii-ui-button ${
                showStop ? "cukii-submit-button--stop" : ""
              }`}
              data-testid="submit-input-button"
              aria-label={showStop ? "Stop response" : "Send message"}
              onClick={(event) => {
                if (showStop) {
                  void dispatch(cancelStream());
                  return;
                }
                props.onEnter?.({
                  useCodebase: false,
                  noContext: useActiveFile
                    ? isMetaEquivalentKeyPressed(event as any) || event.altKey
                    : !(
                        isMetaEquivalentKeyPressed(event as any) || event.altKey
                      ),
                });
              }}
              disabled={isEnterDisabled}
            >
              {showStop ? (
                <span className="cukii-submit-stop-icon h-2.5 w-2.5 rounded-[1px]" />
              ) : isInEdit ? (
                isRetry ? (
                  <ArrowPathIcon className="h-4 w-4" />
                ) : (
                  <PencilIcon className="h-4 w-4" />
                )
              ) : (
                <ArrowUpIcon className="h-4 w-4" />
              )}
            </Button>
          </ToolTip>
        </div>
      </div>

      {modelPickerOpen && (
        <ModelPickerModal
          onClose={() => setModelPickerOpen(false)}
          onSelect={(model) =>
            updateBrokerPreferences(
              model,
              brokerSubagent ?? "auto",
              brokerEffort,
              brokerSpeed,
              hasReasoningEnabled,
              brokerAutocompact,
              "bypass",
            )
          }
        />
      )}
      {vendorAccountsOpen && (
        <VendorAccountsModal
          onClose={() => {
            setVendorAccountsOpen(false);
            void refreshIssueCapability(true);
          }}
        />
      )}
      {reportIssueOpen && (
        <ReportIssueModal
          sessionId={sessionId}
          brokerModel={currentModel}
          returnFocusRef={commandMenuButtonRef}
          onClose={() => {
            setReportIssueOpen(false);
            void refreshIssueCapability(true);
          }}
        />
      )}
    </>
  );
}

function shallowToolbarOptionsEqual(a?: ToolbarOptions, b?: ToolbarOptions) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.hideAddContext === b.hideAddContext &&
    a.hideImageUpload === b.hideImageUpload &&
    a.hideUseCodebase === b.hideUseCodebase &&
    a.hideSelectModel === b.hideSelectModel &&
    a.enterText === b.enterText
  );
}

export default memo(
  InputToolbar,
  (prev, next) =>
    prev.hidden === next.hidden &&
    prev.disabled === next.disabled &&
    prev.isMainInput === next.isMainInput &&
    prev.isInputEmpty === next.isInputEmpty &&
    prev.activeKey === next.activeKey &&
    shallowToolbarOptionsEqual(prev.toolbarOptions, next.toolbarOptions),
);
