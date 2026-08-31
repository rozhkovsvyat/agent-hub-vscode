import { CheckIcon } from "@heroicons/react/24/outline";
import { useContext, useEffect, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  switchBrokerModel,
  setBrokerSubagent,
  type BrokerModel,
  type BrokerSubagent,
} from "../../redux/slices/sessionSlice";
import { applyRuntimeVendorCatalog, VENDORS } from "./vendors";
import { ModelCapabilityRating } from "./ModelCapabilityRating";
import { formatCukiiModelSubtitle } from "core/cukiiModelPresentation";
import {
  brokerVendorForModel,
  defaultVendorPermissionCapabilities,
  resolvePermissionModeForVendor,
} from "core/cukiiPermissionModes";

interface ModelPickerModalProps {
  onClose: () => void;
  onSelect?: (model: BrokerModel) => void;
}

export function ModelPickerModal({ onClose, onSelect }: ModelPickerModalProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentModel =
    useAppSelector((state) => state.session.brokerModel) ?? "opus-5";
  const brokerEffort = useAppSelector((state) => state.session.brokerEffort);
  const brokerSpeed = useAppSelector((state) => state.session.brokerSpeed);
  const thinkingEnabled = useAppSelector(
    (state) => state.session.hasReasoningEnabled,
  );
  const brokerPermissionMode = useAppSelector(
    (state) => state.session.brokerPermissionMode,
  );
  const [, setCatalogVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void ideMessenger
      .request("cukii/listBrokerModelCatalog", undefined)
      .then((response) => {
        if (cancelled || response.status !== "success") return;
        applyRuntimeVendorCatalog(response.content);
        setCatalogVersion((version) => version + 1);
      });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [ideMessenger, onClose]);

  const selectModel = (model: BrokerModel) => {
    const nextSubagent: BrokerSubagent = "auto";
    const capabilities = defaultVendorPermissionCapabilities(
      brokerVendorForModel(model),
    );
    const resolvedPermissionMode = capabilities.supportedModes.includes(
      brokerPermissionMode,
    )
      ? brokerPermissionMode
      : capabilities.supportedModes.includes("bypass")
        ? "bypass"
        : resolvePermissionModeForVendor(capabilities, brokerPermissionMode);
    if (onSelect) {
      onSelect(model);
    } else {
      dispatch(
        switchBrokerModel({
          model,
          displayName:
            VENDORS.flatMap((vendor) => vendor.models).find(
              (entry) => entry.value === model,
            )?.label ?? model,
        }),
      );
      dispatch(setBrokerSubagent(nextSubagent));
      ideMessenger.post("cukii/setBrokerPreferences", {
        brokerModel: model,
        brokerSubagent: nextSubagent,
        brokerEffort,
        brokerSpeed,
        thinkingEnabled,
        brokerPermissionMode: resolvedPermissionMode,
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
            <div className="cursor-default select-none px-3 pb-1 pt-2 text-xs text-[var(--vscode-descriptionForeground)]">
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
                    selected ? "cukii-model-option-selected" : ""
                  } ${model.disabled ? "cursor-not-allowed opacity-45" : ""}`}
                >
                  <span className="min-w-0">
                    <span className="flex min-w-0 items-center gap-[5px] text-[15px] text-[var(--vscode-foreground)]">
                      <span className="truncate">
                        {model.label}
                        {model.disabled ? " (soon)" : ""}
                      </span>
                      <ModelCapabilityRating model={model} />
                    </span>
                    <span className="block truncate text-xs text-[var(--vscode-descriptionForeground)]">
                      {formatCukiiModelSubtitle(
                        model.contextWindowLabel,
                        model.description,
                      )}
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
