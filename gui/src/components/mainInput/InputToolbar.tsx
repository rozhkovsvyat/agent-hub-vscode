import {
  ArrowPathIcon,
  ArrowUpIcon,
  AtSymbolIcon,
  LightBulbIcon as LightBulbIconOutline,
  PencilIcon,
  PhotoIcon,
} from "@heroicons/react/24/outline";
import { LightBulbIcon as LightBulbIconSolid } from "@heroicons/react/24/solid";
import { InputModifiers } from "core";
import {
  modelSupportsImages,
  modelSupportsReasoning,
} from "core/llm/autodetect";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectUseActiveFile } from "../../redux/selectors";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import {
  setBrokerModel,
  setBrokerSubagent,
  setHasReasoningEnabled,
  setMode,
} from "../../redux/slices/sessionSlice";
import type {
  BrokerModel,
  BrokerSubagent,
} from "../../redux/slices/sessionSlice";
import { setReasoningSetting } from "../../redux/slices/uiSlice";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { exitEdit } from "../../redux/thunks/edit";
import { getMetaKeyLabel, isMetaEquivalentKeyPressed } from "../../util";
import { ToolTip } from "../gui/Tooltip";
import ModelSelect from "../modelSelection/ModelSelect";
import { ModelPickerModal } from "../modelSelection/ModelPickerModal";
import { modelInfo } from "../modelSelection/vendors";
import { ModeSelect } from "../ModeSelect";
import { Button, Popover, PopoverButton, PopoverPanel } from "../ui";
import { useFontSize } from "../ui/font";
import ContextStatus from "./ContextStatus";
import HoverItem from "./InputToolbar/HoverItem";

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

function InputToolbar(props: InputToolbarProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const defaultModel = useAppSelector(selectSelectedChatModel);
  const useActiveFile = useAppSelector(selectUseActiveFile);
  const isInEdit = useAppSelector((store) => store.session.isInEdit);
  const isStreaming = useAppSelector((store) => store.session.isStreaming);
  const mode = useAppSelector((store) => store.session.mode);
  const brokerModel = useAppSelector((store) => store.session.brokerModel);
  const brokerSubagent = useAppSelector(
    (store) => store.session.brokerSubagent,
  );
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Once the user picks a model in this session, the in-flight mount request
  // (which reads globalState that may pre-date the pick) must not clobber it.
  const userTouchedBrokerRef = useRef(false);
  useEffect(() => {
    void ideMessenger
      .request("cukii/getBrokerPreferences", undefined)
      .then((result) => {
        if (result.status === "success" && !userTouchedBrokerRef.current) {
          dispatch(setBrokerModel(result.content.brokerModel));
          dispatch(setBrokerSubagent(result.content.brokerSubagent));
          if (result.content.mode) {
            dispatch(setMode(result.content.mode));
          }
        }
      });
  }, [dispatch, ideMessenger]);

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
  };
  const codeToEdit = useAppSelector((store) => store.editModeState.codeToEdit);
  const hasReasoningEnabled = useAppSelector(
    (store) => store.session.hasReasoningEnabled,
  );
  const isEnterDisabled =
    !isStreaming && (props.disabled || (isInEdit && codeToEdit.length === 0));
  const isRetry = props.toolbarOptions?.enterText === "Retry";
  // Stop показываем только когда идёт ход И поле пустое. Есть текст во время
  // хода — кнопка «отправить» (steering-сообщение в ленту), как у Claude.
  const isInputEmpty = props.isInputEmpty ?? true;
  const showStop = isStreaming && isInputEmpty;
  const submitButtonLabel = showStop
    ? "Stop response"
    : isInEdit
      ? isRetry
        ? "Retry edit"
        : "Edit selection"
      : "Send message";

  const supportsImages =
    defaultModel &&
    modelSupportsImages(
      defaultModel.provider,
      defaultModel.model,
      defaultModel.title,
      defaultModel.capabilities,
    );

  const supportsReasoning = modelSupportsReasoning(defaultModel);

  const smallFont = useFontSize(-2);
  const tinyFont = useFontSize(-3);

  return (
    <>
      <div
        onClick={props.onClick}
        // min-w-0 на самой строке: без него flex-контейнер не может стать уже
        // суммы min-content своих групп и выдавливает содержимое за панель —
        // именно так обрезались и кнопка отправки, и текст сообщений.
        className={`find-widget-skip bg-vsc-input-background flex min-w-0 select-none flex-row items-center justify-between gap-1 pt-1 ${props.hidden ? "pointer-events-none h-0 cursor-default opacity-0" : "pointer-events-auto mt-2 cursor-text opacity-100"}`}
        style={{
          fontSize: smallFont,
        }}
      >
        <div className="xs:gap-1.5 flex min-w-0 flex-row items-center gap-1">
          {!isInEdit && (
            <ToolTip place="top" content="Select Mode">
              <HoverItem className="!p-0">
                <ModeSelect />
              </HoverItem>
            </ToolTip>
          )}
          {mode === "broker" && !isInEdit ? (
            <div className="flex min-w-0 flex-row items-center gap-1.5">
              <Popover className="relative">
                <PopoverButton
                  data-testid="broker-menu-button"
                  className="text-description hover:text-foreground flex h-[22px] w-[22px] items-center justify-center rounded border border-[var(--vscode-descriptionForeground,#55524c)] bg-transparent text-xs font-medium transition-colors"
                  title="Model menu"
                >
                  /
                </PopoverButton>
                <PopoverPanel className="bg-vsc-background absolute bottom-full left-0 z-50 mb-1 min-w-[180px] rounded border border-[var(--vscode-panel-border,#333)] shadow-lg">
                  {({ close }) => (
                    <div className="py-1">
                      <button
                        type="button"
                        data-testid="broker-switch-model"
                        className="text-description w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]"
                        onClick={() => {
                          close();
                          setModelPickerOpen(true);
                        }}
                      >
                        Switch model…
                      </button>
                    </div>
                  )}
                </PopoverPanel>
              </Popover>
              <span
                className="text-description-muted truncate text-xs"
                data-testid="broker-model-label"
                title={modelInfo(brokerModel ?? "codex-5-6-terra")?.label}
              >
                {modelInfo(brokerModel ?? "codex-5-6-terra")?.label ??
                  "Select model"}
              </span>
              {modelPickerOpen && (
                <ModelPickerModal onClose={() => setModelPickerOpen(false)} />
              )}
            </div>
          ) : (
            <ToolTip place="top" content="Select Model">
              <HoverItem className="!p-0">
                <ModelSelect />
              </HoverItem>
            </ToolTip>
          )}
          <div className="xs:flex text-description -mb-1 hidden items-center transition-colors duration-200">
            {props.toolbarOptions?.hideImageUpload ||
              (supportsImages && (
                <>
                  <input
                    type="file"
                    ref={fileInputRef}
                    style={{ display: "none" }}
                    accept=".jpg,.jpeg,.png,.gif,.svg,.webp"
                    onChange={(e) => {
                      const files = e.target?.files ?? [];
                      for (const file of files) {
                        props.onImageFileSelected?.(file);
                      }
                      if (fileInputRef.current) {
                        fileInputRef.current.value = "";
                      }
                    }}
                  />

                  <ToolTip place="top" content="Attach Image">
                    <HoverItem className="">
                      <PhotoIcon
                        className="h-3 w-3 hover:brightness-125"
                        onClick={(e) => {
                          fileInputRef.current?.click();
                        }}
                      />
                    </HoverItem>
                  </ToolTip>
                </>
              ))}
            {props.toolbarOptions?.hideAddContext || (
              <ToolTip place="top" content="Attach Context">
                <HoverItem onClick={props.onAddContextItem}>
                  <AtSymbolIcon className="h-3 w-3 hover:brightness-125" />
                </HoverItem>
              </ToolTip>
            )}
            {supportsReasoning && (
              <HoverItem
                onClick={() => {
                  dispatch(setHasReasoningEnabled(!hasReasoningEnabled));
                  if (defaultModel?.title) {
                    dispatch(
                      setReasoningSetting({
                        modelTitle: defaultModel.title,
                        enabled: !hasReasoningEnabled,
                      }),
                    );
                  }
                }}
              >
                <ToolTip
                  place="top"
                  content={
                    hasReasoningEnabled
                      ? "Disable model reasoning"
                      : "Enable model reasoning"
                  }
                >
                  {hasReasoningEnabled ? (
                    <LightBulbIconSolid className="h-3 w-3 brightness-200 hover:brightness-150" />
                  ) : (
                    <LightBulbIconOutline className="h-3 w-3 hover:brightness-150" />
                  )}
                </ToolTip>
              </HoverItem>
            )}
          </div>
        </div>

        <div
          // flex-shrink-0 у правой группы: она короткая и обязана остаться целой,
          // сжиматься должна левая (у пилюль моделей есть truncate и max-width).
          className="text-description flex min-w-0 flex-shrink-0 items-center gap-2 whitespace-nowrap"
          style={{
            fontSize: tinyFont,
          }}
        >
          {!isInEdit && <ContextStatus />}
          {!props.toolbarOptions?.hideUseCodebase && !isInEdit && (
            <div className="hidden transition-colors duration-200 hover:underline md:flex">
              <HoverItem
                className={
                  props.activeKey === "Meta" ||
                  props.activeKey === "Control" ||
                  props.activeKey === "Alt"
                    ? "underline"
                    : ""
                }
                onClick={(e) =>
                  props.onEnter?.({
                    useCodebase: false,
                    noContext: !useActiveFile,
                  })
                }
              >
                <ToolTip
                  place="top-end"
                  content={`${
                    useActiveFile
                      ? "Send Without Active File"
                      : "Send With Active File"
                  } (${getMetaKeyLabel()}⏎)`}
                >
                  <span>
                    {getMetaKeyLabel()}⏎{" "}
                    {useActiveFile ? "No active file" : "Active file"}
                  </span>
                </ToolTip>
              </HoverItem>
            </div>
          )}
          {isInEdit && (
            <HoverItem
              className="hidden hover:underline sm:flex"
              onClick={async () => {
                void dispatch(exitEdit({}));
                ideMessenger.post("focusEditor", undefined);
              }}
            >
              <span>
                <i>Esc</i> to exit Edit
              </span>
            </HoverItem>
          )}
          <ToolTip place="top" content={submitButtonLabel}>
            <Button
              variant={props.isMainInput ? "primary" : "secondary"}
              size="sm"
              className="cukii-submit-button"
              data-testid="submit-input-button"
              aria-label={submitButtonLabel}
              onClick={async (e) => {
                if (showStop) {
                  void dispatch(cancelStream());
                  return;
                }
                if (props.onEnter) {
                  props.onEnter({
                    useCodebase: false,
                    noContext: useActiveFile
                      ? isMetaEquivalentKeyPressed(e as any) || e.altKey
                      : !(isMetaEquivalentKeyPressed(e as any) || e.altKey),
                  });
                }
              }}
              disabled={isEnterDisabled}
            >
              {showStop ? (
                <span
                  className="h-2.5 w-2.5 rounded-[1px] bg-white"
                  aria-hidden="true"
                />
              ) : isInEdit ? (
                isRetry ? (
                  <ArrowPathIcon className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <PencilIcon className="h-4 w-4" aria-hidden="true" />
                )
              ) : (
                <ArrowUpIcon className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </ToolTip>
        </div>
      </div>
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
