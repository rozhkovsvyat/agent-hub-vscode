import {
  ArrowPathIcon,
  ArrowUpIcon,
  CheckIcon,
  PaperClipIcon,
  PencilIcon,
  PhotoIcon,
  ShareIcon,
} from "@heroicons/react/24/outline";
import { InputModifiers } from "core";
import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectUseActiveFile } from "../../redux/selectors";
import {
  newSession,
  setBrokerModel,
  setBrokerSubagent,
  setHasReasoningEnabled,
  setMode,
} from "../../redux/slices/sessionSlice";
import type {
  BrokerModel,
  BrokerSubagent,
} from "../../redux/slices/sessionSlice";
import { setAllowAllPermissions } from "../../redux/slices/uiSlice";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { exitEdit } from "../../redux/thunks/edit";
import { saveCurrentSession } from "../../redux/thunks/session";
import { isMetaEquivalentKeyPressed } from "../../util";
import { ToolTip } from "../gui/Tooltip";
import { ModelPickerModal } from "../modelSelection/ModelPickerModal";
import { modelInfo } from "../modelSelection/vendors";
import { Button, Popover, PopoverButton, PopoverPanel } from "../ui";
import { useFontSize } from "../ui/font";

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
  onClick?: () => void;
  onImageFileSelected?: (file: File) => void;
  hidden?: boolean;
  activeKey: string | null;
  toolbarOptions?: ToolbarOptions;
  disabled?: boolean;
  isMainInput?: boolean;
  isInputEmpty?: boolean;
}

const menuItemClass =
  "cukii-menu-item flex w-full items-center justify-between gap-5 rounded px-3 py-2 text-left text-[13px] text-[var(--vscode-foreground)] hover:bg-[var(--vscode-list-hoverBackground)] disabled:cursor-default disabled:opacity-45";

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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const useActiveFile = useAppSelector(selectUseActiveFile);
  const isInEdit = useAppSelector((state) => state.session.isInEdit);
  const isStreaming = useAppSelector((state) => state.session.isStreaming);
  const historyLength = useAppSelector((state) => state.session.history.length);
  const brokerModel = useAppSelector((state) => state.session.brokerModel);
  const brokerSubagent = useAppSelector(
    (state) => state.session.brokerSubagent,
  );
  const hasReasoningEnabled = useAppSelector(
    (state) => state.session.hasReasoningEnabled,
  );
  const allowAllPermissions = useAppSelector(
    (state) => state.ui.allowAllPermissions,
  );
  const tools = useAppSelector((state) => state.config.config.tools);
  const toolNames = useMemo(
    () => (tools ?? []).map((tool) => tool.function.name),
    [tools],
  );
  const codeToEdit = useAppSelector((state) => state.editModeState.codeToEdit);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [actionQuery, setActionQuery] = useState("");
  const userTouchedBrokerRef = useRef(false);

  useEffect(() => {
    dispatch(setMode("broker"));
    void ideMessenger
      .request("cukii/getBrokerPreferences", undefined)
      .then((result) => {
        if (
          result.status === "success" &&
          !userTouchedBrokerRef.current &&
          !window.initialSessionId &&
          historyLength === 0
        ) {
          dispatch(setBrokerModel(result.content.brokerModel));
          dispatch(setBrokerSubagent(result.content.brokerSubagent));
        }
      });
  }, [dispatch, historyLength, ideMessenger]);

  const updateBrokerPreferences = (
    nextModel: BrokerModel,
    nextSubagent: BrokerSubagent,
  ) => {
    userTouchedBrokerRef.current = true;
    dispatch(setBrokerModel(nextModel));
    dispatch(setBrokerSubagent(nextSubagent));
    ideMessenger.post("cukii/setBrokerPreferences", {
      brokerModel: nextModel,
      brokerSubagent: nextSubagent,
      mode: "broker",
    });
    if (historyLength > 0) {
      void dispatch(
        saveCurrentSession({ openNewSession: false, generateTitle: false }),
      );
    }
  };

  const isEnterDisabled =
    !isStreaming && (props.disabled || (isInEdit && codeToEdit.length === 0));
  const isRetry = props.toolbarOptions?.enterText === "Retry";
  const showStop = isStreaming && (props.isInputEmpty ?? true);
  const currentModel = brokerModel ?? "opus-5";
  const currentLabel = modelInfo(currentModel)?.label ?? "Opus 5";
  const smallFont = useFontSize(-2);
  const showAction = (label: string) =>
    label.toLowerCase().includes(actionQuery.trim().toLowerCase());

  const selectFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      props.onImageFileSelected?.(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <>
      <div
        onClick={props.onClick}
        className={`cukii-input-footer find-widget-skip flex min-w-0 select-none items-center justify-between gap-2 border-t border-[var(--vscode-panel-border)] px-2 pb-1 pt-2 ${
          props.hidden
            ? "pointer-events-none h-0 opacity-0"
            : "pointer-events-auto mt-2 opacity-100"
        }`}
        style={{ fontSize: smallFont }}
      >
        <div className="flex min-w-0 items-center gap-1">
          <input
            ref={fileInputRef}
            type="file"
            hidden
            multiple
            accept=".jpg,.jpeg,.png,.gif,.svg,.webp"
            onChange={(event) => selectFiles(event.target.files)}
          />

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
              <PopoverPanel className="cukii-menu-surface absolute bottom-full left-0 z-[1000] mb-2 w-52 rounded-md border border-[var(--vscode-widget-border)] bg-[var(--vscode-menu-background)] p-1 shadow-xl">
                {({ close }) => (
                  <>
                    <button
                      className={menuItemClass}
                      type="button"
                      onClick={() => {
                        close();
                        fileInputRef.current?.click();
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <PhotoIcon className="h-4 w-4" /> Attach image
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
                        <PaperClipIcon className="h-4 w-4" /> Attach context
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
                data-testid="broker-menu-button"
                onClick={() => setActionQuery("")}
                className="cukii-icon-button flex items-center justify-center rounded text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
                aria-label="Commands and model"
                title="Show command menu (/)"
              >
                <CommandControlIcon />
              </PopoverButton>
              <PopoverPanel className="cukii-command-menu cukii-menu-surface absolute bottom-full left-[-34px] z-[1000] mb-2 max-h-[min(62vh,520px)] w-[calc(100vw-38px)] overflow-y-auto rounded-md border border-[var(--vscode-widget-border)] bg-[var(--vscode-menu-background)] p-1 shadow-2xl">
                {({ close }) => (
                  <div data-testid="cukii-slash-menu">
                    <div className="sticky top-0 z-10 bg-[var(--vscode-menu-background)] p-1">
                      <input
                        autoFocus
                        value={actionQuery}
                        onChange={(event) => setActionQuery(event.target.value)}
                        placeholder="Filter actions..."
                        className="cukii-menu-filter w-full rounded border border-[var(--vscode-input-border)] bg-[var(--vscode-input-background)] px-3 py-2 text-[13px] text-[var(--vscode-input-foreground)] outline-none focus:border-[var(--vscode-focusBorder)]"
                      />
                    </div>
                    <div className="px-3 pb-1 pt-2 text-xs text-[var(--vscode-descriptionForeground)]">
                      Context
                    </div>
                    {showAction("Attach file") && (
                      <button
                        className={menuItemClass}
                        type="button"
                        onClick={() => {
                          close();
                          fileInputRef.current?.click();
                        }}
                      >
                        Attach file…
                      </button>
                    )}
                    {showAction("Mention file from this project") && (
                      <button
                        className={menuItemClass}
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
                        className={menuItemClass}
                        type="button"
                        onClick={() => {
                          close();
                          dispatch(newSession());
                        }}
                      >
                        Clear conversation
                      </button>
                    )}
                    {showAction("Rewind") && (
                      <button className={menuItemClass} type="button" disabled>
                        Rewind
                      </button>
                    )}

                    <div className="my-1 border-t border-[var(--vscode-menu-separatorBackground)]" />
                    <div className="px-3 pb-1 pt-2 text-xs text-[var(--vscode-descriptionForeground)]">
                      Model
                    </div>
                    {showAction("Switch model") && (
                      <button
                        data-testid="broker-switch-model"
                        className={menuItemClass}
                        type="button"
                        onClick={() => {
                          close();
                          setModelPickerOpen(true);
                        }}
                      >
                        <span>Switch model…</span>
                        <span className="text-[var(--vscode-descriptionForeground)]">
                          {currentLabel}
                        </span>
                      </button>
                    )}
                    {showAction("Thinking") && (
                      <button
                        data-testid="cukii-thinking-toggle"
                        className={menuItemClass}
                        type="button"
                        role="switch"
                        aria-checked={Boolean(hasReasoningEnabled)}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          dispatch(setHasReasoningEnabled(!hasReasoningEnabled));
                        }}
                      >
                        <span>Thinking</span>
                        <span
                          data-testid="cukii-thinking-track"
                          className={`flex h-5 w-9 items-center rounded-full px-0.5 ${hasReasoningEnabled ? "justify-end bg-[var(--cukii-accent)]" : "justify-start bg-[var(--vscode-input-background)]"}`}
                        >
                          <span className="h-4 w-4 rounded-full bg-[var(--vscode-button-foreground)]" />
                        </span>
                      </button>
                    )}
                    {showAction("Switch models when a message is flagged") && (
                      <button className={menuItemClass} type="button" disabled>
                        <span>Switch models when a message is flagged</span>
                        <span className="flex h-5 w-9 items-center justify-start rounded-full bg-[var(--vscode-input-background)] px-0.5">
                          <span className="h-4 w-4 rounded-full bg-[var(--vscode-descriptionForeground)]" />
                        </span>
                      </button>
                    )}
                    {showAction("Account & usage") && (
                      <button className={menuItemClass} type="button" disabled>
                        Account &amp; usage…
                      </button>
                    )}
                  </div>
                )}
              </PopoverPanel>
            </Popover>
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

        <div className="flex shrink-0 items-center gap-2">
          {!isInEdit && (
            <button
              type="button"
              className={`cukii-permission-button flex items-center gap-2 rounded px-2 text-xs hover:bg-[var(--vscode-toolbar-hoverBackground)] ${allowAllPermissions ? "text-[var(--vscode-foreground)]" : "text-[var(--vscode-descriptionForeground)]"}`}
              aria-pressed={allowAllPermissions}
              title="Toggle permission mode"
              onClick={() =>
                dispatch(
                  setAllowAllPermissions({
                    enabled: !allowAllPermissions,
                    toolNames,
                  }),
                )
              }
            >
              {allowAllPermissions ? (
                <CheckIcon className="h-4 w-4" />
              ) : (
                <ShareIcon className="h-4 w-4" />
              )}
              Bypass permissions
            </button>
          )}

          <ToolTip
            place="top"
            content={showStop ? "Stop response" : "Send message"}
          >
            <Button
              variant={props.isMainInput ? "primary" : "secondary"}
              size="sm"
              className="cukii-submit-button cukii-ui-button"
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
                <span className="h-2.5 w-2.5 rounded-[1px] bg-white" />
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
            updateBrokerPreferences(model, brokerSubagent ?? "auto")
          }
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
