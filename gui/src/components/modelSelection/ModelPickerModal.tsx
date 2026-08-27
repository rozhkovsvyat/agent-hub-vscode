import { CheckIcon } from "@heroicons/react/24/outline";
import { useContext, useEffect } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  setBrokerModel,
  setBrokerSubagent,
  type BrokerModel,
  type BrokerSubagent,
} from "../../redux/slices/sessionSlice";
import { VENDORS } from "./vendors";

interface ModelPickerModalProps {
  onClose: () => void;
  onSelect?: (model: BrokerModel) => void;
}

const DESCRIPTIONS: Partial<Record<BrokerModel, string>> = {
  "opus-5": "1M context · Best for everyday, complex tasks",
  "fable-5": "Most capable for the hardest and longest-running tasks",
  "sonnet-5": "Efficient for routine tasks",
  "codex-5-6-sol": "Frontier Codex agent for difficult engineering work",
  "codex-5-6-terra": "Balanced Codex agent for everyday work",
  "grok-4-6": "xAI agent through the Cukii bridge",
  "composer-2-5": "Cursor agent through the Cukii bridge",
  "qwen-3-8-max": "Qwen Max agent through the Cukii bridge",
};

export function ModelPickerModal({ onClose, onSelect }: ModelPickerModalProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentModel =
    useAppSelector((state) => state.session.brokerModel) ?? "opus-5";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const selectModel = (model: BrokerModel) => {
    const nextSubagent: BrokerSubagent = "auto";
    if (onSelect) {
      onSelect(model);
    } else {
      dispatch(setBrokerModel(model));
      dispatch(setBrokerSubagent(nextSubagent));
      ideMessenger.post("cukii/setBrokerPreferences", {
        brokerModel: model,
        brokerSubagent: nextSubagent,
        mode: "broker",
      });
    }
    onClose();
  };

  return (
    <div
      className="cukii-model-picker-backdrop fixed inset-0 z-[100000] bg-black/15"
      role="dialog"
      aria-modal="true"
      aria-label="Select a model"
      onMouseDown={onClose}
    >
      <div
        className="cukii-model-picker cukii-menu-surface absolute bottom-[86px] left-[18px] right-[18px] max-h-[min(64vh,570px)] overflow-y-auto rounded-md border border-[var(--vscode-widget-border)] bg-[var(--vscode-menu-background)] p-1 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-[var(--vscode-menu-background)] px-3 pb-2 pt-3 text-xs text-[var(--vscode-descriptionForeground)]">
          Select a model
        </div>

        {VENDORS.map((vendor) => (
          <section key={vendor.id}>
            <div className="px-3 pb-1 pt-2 text-xs text-[var(--vscode-descriptionForeground)]">
              {vendor.label}
            </div>
            {vendor.models.map((model) => {
              const selected = model.value === currentModel;
              return (
                <button
                  key={model.value}
                  type="button"
                  disabled={model.disabled}
                  onClick={() => selectModel(model.value)}
                  className={`cukii-menu-item flex w-full items-center justify-between rounded px-3 py-2 text-left hover:bg-[var(--vscode-list-hoverBackground)] ${
                    selected
                      ? "cukii-model-option-selected"
                      : ""
                  } ${model.disabled ? "cursor-not-allowed opacity-45" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="block text-[15px] text-[var(--vscode-foreground)]">
                      {model.label}
                      {model.disabled ? " (soon)" : ""}
                    </span>
                    <span className="block truncate text-xs text-[var(--vscode-descriptionForeground)]">
                      {DESCRIPTIONS[model.value] ??
                        `${vendor.label} model through the Cukii bridge`}
                    </span>
                  </span>
                  {selected && (
                    <CheckIcon className="ml-3 h-5 w-5 shrink-0 text-[var(--vscode-foreground)]" />
                  )}
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
