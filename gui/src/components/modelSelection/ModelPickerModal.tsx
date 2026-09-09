import { CheckIcon } from "@heroicons/react/24/outline";
import { useContext, useEffect, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  switchBrokerModel,
  setBrokerAutocompact,
  setBrokerEffort,
  setBrokerPermissionMode,
  setBrokerModelScope,
  setBrokerSpeed,
  setBrokerSubagent,
  type BrokerModel,
  type BrokerSubagent,
} from "../../redux/slices/sessionSlice";
import {
  applyRuntimeVendorCatalog,
  isBestModel,
  supportsNativeSpeed,
  VENDORS,
} from "./vendors";
import { ModelCapabilityRating } from "./ModelCapabilityRating";
import { CukiiAutocompactRow } from "../cukii/CukiiAutocompactRow";
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
  const brokerAutocompact = useAppSelector(
    (state) => state.session.brokerAutocompact,
  );
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
        brokerAutocompact,
        thinkingEnabled,
        brokerPermissionMode: "bypass",
        mode: "broker",
      });
    }
    onClose();
  };

  return (
    <>
      {/* Close-on-click-outside only. It used to be the panel's parent too,
          which is what put the menu 86px above the *window* instead of above
          the composer: `fixed inset-0` made the viewport the containing block,
          so the panel overlapped a 103px composer by 17px. */}
      <div
        className="cukii-model-picker-backdrop fixed inset-0 z-[100000]"
        onMouseDown={onClose}
      />
      {/* The menu belongs to the composer and now hangs off its top edge:
          `.cukii-model-picker-lane` is `bottom: 100%` against the composer's
          own positioned box, so the gap is constant whatever the composer's
          height. Measured 1:1 against Claude Code 2.1.261, whose menu is
          `position: absolute; bottom: 100%; margin-bottom: 8px` on its input
          fieldset. The lane must not swallow the backdrop's close-on-click,
          hence pointer-events. */}
      <div className="cukii-model-picker-lane pointer-events-none">
        <div
          className="cukii-model-picker cukii-menu-surface pointer-events-auto max-h-[min(50vh,570px)] rounded-lg border border-[var(--vscode-widget-border)] bg-[var(--vscode-menu-background)] shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="Select a model"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between px-3 pb-1 pt-2">
            <span className="text-[11.7px] text-[var(--vscode-menu-foreground)] opacity-50">
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
                  dispatch(
                    setBrokerModelScope(scope === "best" ? "all" : "best"),
                  )
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
                  dispatch(
                    setBrokerModelScope(scope === "best" ? "all" : "best"),
                  )
                }
              >
                <span className="cukii-scope-switch-knob" />
              </button>
            </span>
          </div>

          <div className="cukii-model-picker-list">
            {visibleVendors.map((vendor) => (
              <section key={vendor.id}>
                <div className="cukii-picker-section-header cursor-default select-none">
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
                      className={`cukii-menu-item flex w-full items-center justify-between text-left hover:bg-[var(--vscode-list-hoverBackground)] ${
                        selected ? "cukii-model-option-selected" : ""
                      } ${model.disabled ? "cursor-not-allowed opacity-45" : ""}`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col leading-[1.2]">
                        <span className="flex min-w-0 items-center gap-[5px] text-[13px] text-[var(--vscode-foreground)]">
                          <span className="truncate">
                            {model.label}
                            {model.disabled ? " (soon)" : ""}
                          </span>
                          <ModelCapabilityRating model={model} />
                        </span>
                        <span className="cukii-model-description block truncate">
                          {formatCukiiModelSubtitle(
                            model.contextWindowLabel,
                            model.description,
                          )}
                        </span>
                      </span>
                      <span className="cukii-model-check-col">
                        {selected && (
                          <CheckIcon className="text-[var(--vscode-foreground)]" />
                        )}
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}
          </div>

          {/* Keep the model pill footer in the requested stable order:
              Autocompact, Effort, then Fast when the route supports it. */}
          <div className="border-t border-[var(--vscode-widget-border)] px-1 pb-1 pt-1">
            <CukiiAutocompactRow
              className="cukii-effort-menu-row cukii-menu-item flex w-full min-w-0 items-center justify-between text-left"
              autocompact={brokerAutocompact}
              onAutocompactChange={(nextAutocompact) => {
                dispatch(setBrokerAutocompact(nextAutocompact));
                ideMessenger.post("cukii/setBrokerPreferences", {
                  brokerModel: currentModel,
                  brokerSubagent: "auto",
                  brokerEffort,
                  brokerSpeed,
                  brokerAutocompact: nextAutocompact,
                  thinkingEnabled,
                  brokerPermissionMode,
                  mode: "broker",
                });
              }}
            />
            <CukiiEffortRow
              className="cukii-effort-menu-row cukii-menu-item flex w-full min-w-0 items-center justify-between text-left"
              model={currentModel}
              effort={brokerEffort}
              onEffortChange={(nextEffort) => {
                dispatch(setBrokerEffort(nextEffort));
                ideMessenger.post("cukii/setBrokerPreferences", {
                  brokerModel: currentModel,
                  brokerSubagent: "auto",
                  brokerEffort: nextEffort,
                  brokerSpeed,
                  brokerAutocompact,
                  thinkingEnabled,
                  brokerPermissionMode,
                  mode: "broker",
                });
              }}
            />
            {supportsNativeSpeed(currentModel) && (
              <button
                data-testid="cukii-model-fast-toggle"
                type="button"
                role="switch"
                aria-checked={brokerSpeed === "fast"}
                title="Use the vendor's native accelerated service tier"
                className="cukii-effort-menu-row cukii-menu-item flex w-full min-w-0 items-center justify-between text-left"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const nextSpeed =
                    brokerSpeed === "fast" ? "standard" : "fast";
                  dispatch(setBrokerSpeed(nextSpeed));
                  ideMessenger.post("cukii/setBrokerPreferences", {
                    brokerModel: currentModel,
                    brokerSubagent: "auto",
                    brokerEffort,
                    brokerSpeed: nextSpeed,
                    brokerAutocompact,
                    thinkingEnabled,
                    brokerPermissionMode,
                    mode: "broker",
                  });
                }}
              >
                <span>Fast mode</span>
                <span
                  className={`cukii-toggle-track ${brokerSpeed === "fast" ? "cukii-toggle-track-on" : ""}`}
                >
                  <span className="cukii-toggle-thumb" />
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
