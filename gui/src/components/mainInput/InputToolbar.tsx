import {
  ArrowPathIcon,
  ArrowUpIcon,
  AtSymbolIcon,
  CheckIcon,
  ChevronDownIcon,
  CubeIcon,
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
import { memo, useContext, useRef } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { selectUseActiveFile } from "../../redux/selectors";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import {
  setBrokerModel,
  setBrokerSubagent,
  setHasReasoningEnabled,
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
import { ModeSelect } from "../ModeSelect";
import { Button } from "../ui";
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "../ui";
import { useFontSize } from "../ui/font";
import ContextStatus from "./ContextStatus";
import HoverItem from "./InputToolbar/HoverItem";

const BROKER_MODEL_OPTIONS: Array<{
  value: BrokerModel;
  label: string;
}> = [
  { value: "opus-5", label: "Opus 5" },
  { value: "fable-5", label: "Fable 5" },
  { value: "codex-5-6-terra", label: "Codex 5.6 Terra" },
  { value: "grok-4-6", label: "Grok 4.6" },
  { value: "composer-2-5", label: "Composer 2.5" },
];

const BROKER_SUBAGENT_OPTIONS: Array<{
  value: BrokerSubagent;
  label: string;
}> = [{ value: "auto", label: "Auto" }, ...BROKER_MODEL_OPTIONS];

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
  const selectedBrokerModel =
    BROKER_MODEL_OPTIONS.find((option) => option.value === brokerModel) ??
    BROKER_MODEL_OPTIONS[1];
  const selectedBrokerSubagent =
    BROKER_SUBAGENT_OPTIONS.find((option) => option.value === brokerSubagent) ??
    BROKER_SUBAGENT_OPTIONS[0];

  const renderBrokerPicker = <T extends BrokerModel | BrokerSubagent>({
    value,
    options,
    selectedLabel,
    heading,
    testId,
    tooltip,
    segment,
    onChange,
  }: {
    value: T | undefined;
    options: Array<{ value: T; label: string }>;
    selectedLabel: string;
    heading: string;
    testId: string;
    tooltip: string;
    segment?: "left" | "right";
    onChange: (value: T) => void;
  }) => (
    <ToolTip place="top" content={tooltip}>
      <HoverItem className="!p-0">
        <Listbox value={value} onChange={onChange}>
          <div className="relative flex min-w-0">
            <ListboxButton
              data-testid={testId}
              className={`text-description h-[22px] max-w-[180px] gap-1 border-none px-2 ${segment === "left" ? "cukii-segment-left" : ""} ${segment === "right" ? "cukii-segment-right" : ""}`}
            >
              <CubeIcon className="h-3 w-3 flex-shrink-0" />
              <span className="min-w-0 truncate hover:brightness-110">
                {selectedLabel}
              </span>
              <ChevronDownIcon
                className="hidden h-2 w-2 flex-shrink-0 hover:brightness-110 min-[250px]:flex"
                aria-hidden="true"
              />
            </ListboxButton>
            <ListboxOptions className="min-w-[210px]">
              <div className="text-description-muted px-2 py-1 text-xs font-medium">
                {heading}
              </div>
              {options.map((option) => (
                <ListboxOption key={option.value} value={option.value}>
                  <div className="flex min-w-0 items-center gap-2 py-0.5">
                    <CubeIcon className="h-3 w-3 flex-shrink-0" />
                    <span className="truncate">{option.label}</span>
                  </div>
                  <CheckIcon
                    className={`ml-auto h-3 w-3 ${
                      option.value === value ? "" : "opacity-0"
                    }`}
                  />
                </ListboxOption>
              ))}
            </ListboxOptions>
          </div>
        </Listbox>
      </HoverItem>
    </ToolTip>
  );

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
            <div className="cukii-broker-segmented flex min-w-0 flex-row items-center">
              {renderBrokerPicker<BrokerModel>({
                value: brokerModel,
                options: BROKER_MODEL_OPTIONS,
                selectedLabel: selectedBrokerModel.label,
                heading: "Broker model",
                testId: "broker-model-select-button",
                tooltip: "Select Broker Model",
                segment: "left",
                onChange: (value) => dispatch(setBrokerModel(value)),
              })}
              {renderBrokerPicker<BrokerSubagent>({
                value: brokerSubagent,
                options: BROKER_SUBAGENT_OPTIONS,
                selectedLabel: selectedBrokerSubagent.label,
                heading: "Subagent model",
                testId: "broker-subagent-select-button",
                tooltip: "Select Subagent Model",
                segment: "right",
                onChange: (value) => dispatch(setBrokerSubagent(value)),
              })}
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
