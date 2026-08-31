import { CheckIcon } from "@heroicons/react/24/outline";
import {
  CUKII_PERMISSION_MODE_COPY,
  brokerVendorForModel,
  cyclePermissionMode,
  defaultVendorPermissionCapabilities,
  resolvePermissionModeForVendor,
  visiblePermissionModes,
  type CukiiPermissionMode,
} from "core/cukiiPermissionModes";
import type { BrokerModel, BrokerVendorId } from "core/protocol/ideWebview";
import { useContext, useEffect, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { Popover, PopoverButton, PopoverPanel } from "../ui";

const modeRowClass =
  "cukii-permission-mode-row flex w-full items-start gap-3 px-3 py-2 text-left";

function PermissionModeIcon({ mode }: { mode: CukiiPermissionMode }) {
  const paths: Record<CukiiPermissionMode, string> = {
    manual: "M8 2v12M3 7h10",
    editAutomatically: "M3 12l1.7-.4L12 4.3 10.3 2.6 3 9.9V12z",
    plan: "M3 3h10M3 7h7M3 11h5",
    auto: "M8 2l1.2 3.8L13 7l-3.8 1.2L8 12l-1.2-3.8L3 7l3.8-1.2L8 2z",
    bypass: "M8 2l5 2v3c0 3.1-2.1 5.6-5 6-2.9-.4-5-2.9-5-6V4l5-2z",
  };
  return (
    <svg
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 shrink-0"
      data-testid={`cukii-permission-icon-${mode}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      viewBox="0 0 16 16"
    >
      <path d={paths[mode]} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type CapabilityMap = Partial<
  Record<BrokerVendorId, { supportedModes: CukiiPermissionMode[] }>
>;

function staticCapabilities(vendor: BrokerVendorId) {
  return ["claude", "codex", "kimi", "qwen"].includes(vendor)
    ? defaultVendorPermissionCapabilities(vendor)
    : undefined;
}

export function PermissionModeControl({
  brokerModel,
  permissionMode,
  onChange,
}: {
  brokerModel: BrokerModel;
  permissionMode: CukiiPermissionMode;
  onChange: (mode: CukiiPermissionMode) => void;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [capabilities, setCapabilities] = useState<CapabilityMap>({});

  useEffect(() => {
    let cancelled = false;
    void ideMessenger
      .request("cukii/listPermissionCapabilities", undefined)
      .then((response) => {
        if (cancelled || response.status !== "success") return;
        const next: CapabilityMap = {};
        for (const entry of response.content) {
          next[entry.vendor] = { supportedModes: entry.supportedModes };
        }
        setCapabilities(next);
      })
      .catch(() => {
        // The static contracts below are deliberately retained on probe error.
      });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger]);

  const vendor = brokerVendorForModel(brokerModel);
  const fallback = useMemo(() => staticCapabilities(vendor), [vendor]);
  const visibleModes = useMemo(() => {
    const live = capabilities[vendor];
    const supportedModes = [
      ...(fallback?.supportedModes ?? []),
      ...(live?.supportedModes ?? []),
    ];
    return visiblePermissionModes({
      vendor,
      supportedModes: [...new Set(supportedModes)],
      helpSource: live ? "live+static" : "static",
    });
  }, [capabilities, fallback, vendor]);

  const resolvedPermissionMode = useMemo(() => {
    if (visibleModes.includes(permissionMode)) return permissionMode;
    if (visibleModes.length === 1 && visibleModes[0] === "bypass") {
      return "bypass";
    }
    return resolvePermissionModeForVendor(
      { vendor, supportedModes: visibleModes, helpSource: "displayed" },
      permissionMode,
    );
  }, [permissionMode, vendor, visibleModes]);

  // A model can be changed while the capability request is still in flight.
  // Once the actual native CLI has answered, never leave the session pointing
  // at a mode that this concrete bridge cannot honour.
  useEffect(() => {
    if (resolvedPermissionMode !== permissionMode) {
      onChange(resolvedPermissionMode);
    }
  }, [onChange, permissionMode, resolvedPermissionMode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        !event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea") &&
        !target.closest(".cukii-permission-button")
      ) {
        return;
      }
      if (visibleModes.length === 0) return;
      event.preventDefault();
      onChange(cyclePermissionMode(permissionMode, visibleModes));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onChange, permissionMode, visibleModes]);

  if (visibleModes.length === 0) {
    return null;
  }

  const hasSelectedVisibleMode = visibleModes.includes(resolvedPermissionMode);
  const currentCopy = hasSelectedVisibleMode
    ? CUKII_PERMISSION_MODE_COPY[resolvedPermissionMode]
    : { title: "Select permission mode" };

  return (
    <Popover className="relative">
      <PopoverButton
        type="button"
        className="cukii-permission-button flex items-center gap-2 rounded px-2 text-xs text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
        title="Toggle permission mode"
        aria-label="Toggle permission mode"
      >
        <span className="cukii-permission-label">{currentCopy.title}</span>
      </PopoverButton>
      <PopoverPanel
        className="cukii-permission-popover cukii-menu-surface absolute bottom-full right-0 z-[1000] mb-2 w-[min(360px,calc(100vw-2rem))]"
        data-testid="cukii-permission-popover"
      >
        {({ close }) => (
          <>
            <div className="flex items-center justify-between px-3 pb-1 pt-2 text-xs text-[var(--vscode-descriptionForeground)]">
              <span>Modes</span>
              <span className="flex items-center gap-1" aria-label="Shift+Tab">
                <kbd className="cukii-permission-keycap inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--vscode-keybindingLabel-border)] bg-[var(--vscode-keybindingLabel-background)] px-1 font-mono text-[10px] text-[var(--vscode-keybindingLabel-foreground)] shadow-[0_1px_0_var(--vscode-widget-shadow)]">
                  ⇧
                </kbd>
                <kbd className="cukii-permission-keycap inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--vscode-keybindingLabel-border)] bg-[var(--vscode-keybindingLabel-background)] px-1 font-mono text-[10px] text-[var(--vscode-keybindingLabel-foreground)] shadow-[0_1px_0_var(--vscode-widget-shadow)]">
                  Tab
                </kbd>
              </span>
            </div>
            {visibleModes.map((mode) => {
              const copy = CUKII_PERMISSION_MODE_COPY[mode];
              const selected =
                hasSelectedVisibleMode && mode === resolvedPermissionMode;
              return (
                <button
                  key={mode}
                  type="button"
                  className={`${modeRowClass} ${
                    selected ? "cukii-permission-mode-selected" : ""
                  }`}
                  data-testid={`cukii-permission-mode-${mode}`}
                  onClick={() => {
                    onChange(mode);
                    close();
                  }}
                >
                  <PermissionModeIcon mode={mode} />
                  <span className="min-w-0 flex-1">
                    <span className="cukii-permission-mode-title block text-[13px] font-medium">
                      {copy.title}
                    </span>
                    <span className="cukii-permission-mode-description mt-0.5 block text-xs">
                      {copy.description}
                    </span>
                  </span>
                  {selected && (
                    <CheckIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                </button>
              );
            })}
          </>
        )}
      </PopoverPanel>
    </Popover>
  );
}
