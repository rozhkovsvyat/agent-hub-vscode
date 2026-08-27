import { useEffect, useMemo, useState } from "react";
import {
  CheckIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
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
import { VENDORS, modelInfo, type VendorId, type VendorInfo } from "./vendors";

interface ModelPickerModalProps {
  onClose: () => void;
}

const VENDOR_META: Record<
  VendorId,
  { initials: string; bg: string; fg: string }
> = {
  claude: { initials: "Cl", bg: "#d97757", fg: "#fff" },
  codex: { initials: "Co", bg: "#10a37f", fg: "#fff" },
  xai: { initials: "X", bg: "#1c1c1c", fg: "#fff" },
  cursor: { initials: "Cu", bg: "#5c5cff", fg: "#fff" },
  kimi: { initials: "K", bg: "#e3a867", fg: "#1a1a1a" },
  deepseek: { initials: "D", bg: "#4d6bfa", fg: "#fff" },
};

function VendorIcon({ vendor }: { vendor: VendorInfo }) {
  const meta = VENDOR_META[vendor.id];
  if (!meta) return null;
  return (
    <span
      className="mr-2 inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold"
      style={{ backgroundColor: meta.bg, color: meta.fg }}
      aria-hidden="true"
    >
      {meta.initials}
    </span>
  );
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
  const [query, setQuery] = useState("");

  const selectedVendor = useMemo(
    () => VENDORS.find((v) => v.id === selectedVendorId) ?? VENDORS[0],
    [selectedVendorId],
  );

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return selectedVendor.models;
    return selectedVendor.models.filter((m) =>
      m.label.toLowerCase().includes(q),
    );
  }, [selectedVendor, query]);

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
      className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Switch model"
    >
      <div
        className="flex max-h-[min(80vh,520px)] w-full max-w-[540px] flex-col overflow-hidden rounded-lg shadow-2xl"
        style={{
          backgroundColor: "var(--vscode-panel-background, #1e1e1e)",
          border: "1px solid var(--vscode-panel-border, #333333)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-4 py-3"
          style={{ borderColor: "var(--vscode-panel-border, #333333)" }}
        >
          <h2
            className="text-base font-medium"
            style={{ color: "var(--vscode-foreground, #cccccc)" }}
          >
            Switch model
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="m-0 rounded p-1"
            style={{ color: "var(--vscode-foreground, #cccccc)" }}
          >
            <XMarkIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Vendor list */}
          <div
            className="w-[148px] min-w-0 shrink-0 overflow-y-auto border-r py-2"
            style={{ borderColor: "var(--vscode-panel-border, #333333)" }}
          >
            {VENDORS.map((vendor) => {
              const isSelected = vendor.id === selectedVendorId;
              return (
                <button
                  key={vendor.id}
                  type="button"
                  onClick={() => {
                    setSelectedVendorId(vendor.id);
                    setQuery("");
                  }}
                  className={cn(
                    "flex w-full items-center px-3 py-2 text-left text-sm transition-colors",
                    isSelected
                      ? "font-medium"
                      : "hover:bg-[color:var(--vscode-list-hoverBackground,#2a2d2e)]",
                  )}
                  style={{
                    color: isSelected
                      ? "var(--vscode-list-activeSelectionForeground, #ffffff)"
                      : "var(--vscode-descriptionForeground, #979797)",
                    backgroundColor: isSelected
                      ? "var(--vscode-list-activeSelectionBackground, #094771)"
                      : undefined,
                  }}
                >
                  <VendorIcon vendor={vendor} />
                  <span className="min-w-0 truncate">{vendor.label}</span>
                </button>
              );
            })}
          </div>

          {/* Model list */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
            {/* Search */}
            <div className="sticky top-0 z-10 border-b px-3 py-2">
              <div
                className="flex items-center gap-2 rounded px-2 py-1.5"
                style={{
                  backgroundColor: "var(--vscode-input-background, #3c3c3c)",
                  border: "1px solid var(--vscode-input-border, #3c3c3c)",
                }}
              >
                <MagnifyingGlassIcon
                  className="h-3.5 w-3.5 flex-shrink-0"
                  style={{
                    color: "var(--vscode-input-placeholderForeground, #a6a6a6)",
                  }}
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  style={{
                    color: "var(--vscode-input-foreground, #cccccc)",
                  }}
                  data-testid="model-picker-search"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="flex-shrink-0"
                    aria-label="Clear search"
                  >
                    <XMarkIcon
                      className="h-3.5 w-3.5"
                      style={{
                        color:
                          "var(--vscode-input-placeholderForeground, #a6a6a6)",
                      }}
                    />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 py-2">
              {filteredModels.length === 0 ? (
                <div
                  className="px-4 py-6 text-center text-sm"
                  style={{
                    color: "var(--vscode-descriptionForeground, #979797)",
                  }}
                  data-testid="model-picker-empty"
                >
                  No models match “{query}”
                </div>
              ) : (
                filteredModels.map((model) => {
                  const isSelected = model.value === currentModel;
                  return (
                    <button
                      key={model.value}
                      type="button"
                      disabled={model.disabled}
                      onClick={() => handleSelectModel(model.value)}
                      className={cn(
                        "flex min-h-0 w-full items-center justify-between px-4 py-2 text-left text-sm transition-colors",
                        isSelected
                          ? "font-medium"
                          : !model.disabled &&
                              "hover:bg-[color:var(--vscode-list-hoverBackground,#2a2d2e)]",
                        model.disabled && "cursor-not-allowed opacity-50",
                      )}
                      style={{
                        color: isSelected
                          ? "var(--vscode-list-activeSelectionForeground, #ffffff)"
                          : model.disabled
                            ? "var(--vscode-disabledForeground, #666666)"
                            : "var(--vscode-foreground, #cccccc)",
                        backgroundColor: isSelected
                          ? "var(--vscode-list-activeSelectionBackground, #094771)"
                          : undefined,
                      }}
                    >
                      <span className="min-w-0 truncate">
                        {model.label}
                        {model.disabled && (
                          <span
                            className="ml-2 text-xs"
                            style={{
                              color:
                                "var(--vscode-descriptionForeground, #979797)",
                            }}
                          >
                            (soon)
                          </span>
                        )}
                      </span>
                      {isSelected && (
                        <CheckIcon
                          className="ml-2 h-4 w-4 flex-shrink-0"
                          style={{
                            color:
                              "var(--vscode-list-activeSelectionForeground, #ffffff)",
                          }}
                        />
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
