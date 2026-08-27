import { useEffect, useMemo, useState } from "react";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useContext } from "react";
import {
  setBrokerModel,
  setBrokerSubagent,
  type BrokerModel,
  type BrokerSubagent,
} from "../../redux/slices/sessionSlice";
import { Button } from "../ui";
import { cn } from "../../util/cn";
import { VENDORS, modelInfo, type VendorId } from "./vendors";

interface ModelPickerModalProps {
  onClose: () => void;
}

export function ModelPickerModal({ onClose }: ModelPickerModalProps) {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const brokerModel = useAppSelector((state) => state.session.brokerModel);

  const currentModel = brokerModel ?? "codex-5-6-terra";
  const currentVendor = useMemo(
    () => VENDORS.find((v) => v.models.some((m) => m.value === currentModel)),
    [currentModel],
  );

  const [selectedVendorId, setSelectedVendorId] = useState<VendorId>(
    currentVendor?.id ?? "claude",
  );

  const selectedVendor = useMemo(
    () => VENDORS.find((v) => v.id === selectedVendorId) ?? VENDORS[0],
    [selectedVendorId],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSelectModel = (model: BrokerModel) => {
    const info = modelInfo(model);
    if (!info || info.disabled) {
      return;
    }
    const nextSubagent: BrokerSubagent = "auto";
    dispatch(setBrokerModel(model));
    dispatch(setBrokerSubagent(nextSubagent));
    ideMessenger.post("cukii/setBrokerPreferences", {
      brokerModel: model,
      brokerSubagent: nextSubagent,
      mode: "broker",
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[0.5px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Switch model"
    >
      <div
        className="bg-vsc-background flex max-h-[80vh] w-full max-w-[720px] flex-col overflow-hidden rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--vscode-panel-border,#333)] px-4 py-3">
          <h2 className="text-foreground text-base font-medium">
            Switch model
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <XMarkIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Vendor list */}
          <div className="w-[180px] min-w-0 overflow-y-auto border-r border-[var(--vscode-panel-border,#333)] py-2">
            {VENDORS.map((vendor) => (
              <button
                key={vendor.id}
                type="button"
                onClick={() => setSelectedVendorId(vendor.id)}
                className={cn(
                  "w-full px-4 py-2 text-left text-sm transition-colors",
                  selectedVendorId === vendor.id
                    ? "text-foreground bg-[var(--vscode-list-activeSelectionBackground,#37373d)]"
                    : "text-description hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]",
                )}
              >
                {vendor.label}
              </button>
            ))}
          </div>

          {/* Model list */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto py-2">
            {selectedVendor.models.map((model) => {
              const isSelected = model.value === currentModel;
              return (
                <button
                  key={model.value}
                  type="button"
                  disabled={model.disabled}
                  onClick={() => handleSelectModel(model.value)}
                  className={cn(
                    "flex items-center justify-between px-4 py-2 text-left text-sm transition-colors",
                    isSelected
                      ? "text-foreground bg-[var(--vscode-list-activeSelectionBackground,#37373d)]"
                      : "text-description hover:bg-[var(--vscode-list-hoverBackground,#2a2d2e)]",
                    model.disabled && "cursor-not-allowed opacity-40",
                  )}
                >
                  <span className="truncate">
                    {model.label}
                    {model.disabled && (
                      <span className="text-description-muted ml-2 text-xs">
                        (soon)
                      </span>
                    )}
                  </span>
                  {isSelected && (
                    <CheckIcon className="text-foreground h-4 w-4 flex-shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
