import { CheckIcon } from "@heroicons/react/24/outline";
import { useContext, useEffect, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  switchBrokerModel,
  setBrokerEffort,
  setBrokerPermissionMode,
  setBrokerModelScope,
  setBrokerSubagent,
  type BrokerModel,
  type BrokerSubagent,
} from "../../redux/slices/sessionSlice";
import { applyRuntimeVendorCatalog, isBestModel, VENDORS } from "./vendors";
import { ModelCapabilityRating } from "./ModelCapabilityRating";
import { CukiiEffortRow } from "../cukii/CukiiEffortRow";
import { formatCukiiModelSubtitle } from "core/cukiiModelPresentation";

interface ModelPickerModalProps {
  onClose: () => void;
  onSelect?: (model: BrokerModel) => void;
}

export function ModelPickerModal({ onClose, onSelect }: ModelPickerModalProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const currentModel =
    useAppSelector((state) => state.session.brokerModel) ?? "qwen-3-8-max";
  const brokerEffort = useAppSelector((state) => state.session.brokerEffort);
  const brokerSpeed = useAppSelector((state) => state.session.brokerSpeed);
  const thinkingEnabled = useAppSelector(
    (state) => state.session.hasReasoningEnabled,
  );
  const [catalogVersion, setCatalogVersion] = useState(0);
  const scope = useAppSelector(
    (state) => state.session.brokerModelScope ?? "best",
  );
  const brokerPermissionMode = useAppSelector(
    (state) => state.session.brokerPermissionMode,
  );

  /** Vendors are alphabetical (account-management order) and the Milky
   * (best) scope keeps only rated live routes; vendors left empty disappear
   * entirely. */
  const visibleVendors = useMemo(() => {
    const ordered = [...VENDORS].sort((left, right) =>
      left.label.localeCompare(right.label, "en", { sensitivity: "base" }),
    );
    if (scope === "all") return ordered;
    return ordered
      .map((vendor) => ({
        ...vendor,
        models: vendor.models.filter((model) => isBestModel(model)),
      }))
      .filter((vendor) => vendor.models.length > 0);
  }, [scope, catalogVersion]);

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
      dispatch(setBrokerPermissionMode("bypass"));
      ideMessenger.post("cukii/setBrokerPreferences", {
        brokerModel: model,
        brokerSubagent: nextSubagent,
        brokerEffort,
        brokerSpeed,
        thinkingEnabled,
        brokerPermissionMode: "bypass",
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
        <div className="sticky top-0 z-10 flex items-center justify-between bg-[var(--vscode-menu-background)] px-3 pb-2 pt-3">
          <span className="text-xs text-[var(--vscode-descriptionForeground)]">
            Select a model
          </span>
          <span
            className="cukii-scope-toggle flex items-center gap-[6px]"
            role="group"
            aria-label="Model list scope"
          >
            <button
              type="button"
              data-testid="cukii-scope-toggle-milky"
              aria-pressed={scope === "best"}
              className={`cukii-scope-label ${
                scope === "best" ? "cukii-scope-label-on" : ""
              }`}
              onClick={() =>
                dispatch(setBrokerModelScope(scope === "best" ? "all" : "best"))
              }
            >
              Milky
            </button>
            <button
              type="button"
              data-testid="cukii-scope-switch"
              role="switch"
              aria-checked={scope === "best"}
              aria-label="Show only Milky-rated models"
              className={`cukii-scope-switch ${
                scope === "best" ? "cukii-scope-switch-on" : ""
              }`}
              onClick={() =>
                dispatch(setBrokerModelScope(scope === "best" ? "all" : "best"))
              }
            >
              <span className="cukii-scope-switch-knob" />
            </button>
          </span>
        </div>

        {visibleVendors.map((vendor) => (
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

        {/* Claude keeps its effort control as the last row of the model menu;
            the shared slider row gives Cukii the same footer. */}
        <div className="sticky bottom-0 z-10 border-t border-[var(--vscode-widget-border)] bg-[var(--vscode-menu-background)] px-1 pb-1 pt-1">
          <CukiiEffortRow
            className="flex w-full min-w-0 items-center justify-between gap-3 rounded px-3 py-2 text-left text-[13px] text-[var(--vscode-foreground)]"
            model={currentModel}
            effort={brokerEffort}
            onEffortChange={(nextEffort) => {
              dispatch(setBrokerEffort(nextEffort));
              ideMessenger.post("cukii/setBrokerPreferences", {
                brokerModel: currentModel,
                brokerSubagent: "auto",
                brokerEffort: nextEffort,
                brokerSpeed,
                thinkingEnabled,
                brokerPermissionMode,
                mode: "broker",
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
