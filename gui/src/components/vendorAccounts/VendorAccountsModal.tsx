import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type {
  BrokerVendorAuthAction,
  BrokerVendorAuthStatus,
} from "core/protocol/ideWebview";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";

interface VendorAccountsModalProps {
  onClose: () => void;
}

type RefreshReason = "initial" | "user" | "action";

const ACTION_LABELS: Record<BrokerVendorAuthAction, string> = {
  install: "Install",
  login: "Log in",
  logout: "Log out",
};

export function VendorAccountsModal({ onClose }: VendorAccountsModalProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [accounts, setAccounts] = useState<BrokerVendorAuthStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [refreshError, setRefreshError] = useState<string>();
  const [actionNotice, setActionNotice] = useState<string>();
  const refreshInFlight = useRef(false);
  const authActionOpening = useRef(false);
  const pendingExplicitRefresh = useRef<
    | {
        reason: "user" | "action";
        generation: number;
      }
    | undefined
  >(undefined);
  const explicitRefreshGeneration = useRef(0);

  const refresh = useCallback(
    async (reason: RefreshReason, queuedGeneration?: number) => {
      // Native auth can change as soon as the terminal opens. No refresh is
      // allowed to paint the preceding snapshot before the action completes.
      if (authActionOpening.current) return;
      const explicit = reason === "user" || reason === "action";
      const generation =
        queuedGeneration ??
        (explicit
          ? ++explicitRefreshGeneration.current
          : explicitRefreshGeneration.current);
      if (reason === "user") setLoading(true);
      if (refreshInFlight.current) {
        if (explicit) {
          // Only user/action intent invalidates the active result.
          pendingExplicitRefresh.current = { reason, generation };
        }
        return;
      }
      refreshInFlight.current = true;
      try {
        const response = await ideMessenger.request(
          "cukii/listVendorAccounts",
          undefined,
        );
        if (generation !== explicitRefreshGeneration.current) return;
        if (response.status === "success") {
          setAccounts(response.content);
          setRefreshError(undefined);
        } else {
          setRefreshError(response.error);
        }
      } finally {
        refreshInFlight.current = false;
        if (generation === explicitRefreshGeneration.current) {
          setLoading(false);
        }
        const queuedExplicit = pendingExplicitRefresh.current;
        if (queuedExplicit) {
          pendingExplicitRefresh.current = undefined;
          void refresh(queuedExplicit.reason, queuedExplicit.generation);
        }
      }
    },
    [ideMessenger],
  );

  useEffect(() => {
    void refresh("initial");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, refresh]);

  const runAction = async (
    account: BrokerVendorAuthStatus,
    action: BrokerVendorAuthAction,
  ) => {
    const key = `${account.id}:${action}`;
    // The terminal can change native auth while a previous probe is still in
    // flight. Invalidate that snapshot before the terminal opens, rather than
    // briefly painting the old login state after the user requested a change.
    explicitRefreshGeneration.current += 1;
    pendingExplicitRefresh.current = undefined;
    authActionOpening.current = true;
    setBusy(key);
    try {
      const response = await ideMessenger.request("cukii/runVendorAuthAction", {
        vendor: account.id,
        action,
      });
      setActionNotice(
        response.status === "success"
          ? response.content.message
          : response.error,
      );
    } finally {
      authActionOpening.current = false;
      setBusy(undefined);
      // Do not keep the state from before opening the native login/logout flow.
      await refresh("action");
    }
  };

  return (
    <div
      className="cukii-account-overlay fixed inset-0 z-[100000] flex items-center justify-center overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Accounts"
      onMouseDown={onClose}
    >
      <div
        className="cukii-account-dialog mx-4 max-h-[calc(100vh-64px)] w-[400px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-lg p-4"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mb-2 flex items-center justify-between">
          <h3 className="m-0 text-[16px] font-semibold leading-6 text-[var(--vscode-foreground)]">
            Accounts
          </h3>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Refresh vendor accounts"
              title="Refresh status"
              className="cukii-account-icon-button"
              disabled={busy !== undefined}
              onClick={() => void refresh("user")}
            >
              <ArrowPathIcon className={loading ? "animate-spin" : ""} />
            </button>
            <button
              type="button"
              aria-label="Close vendor accounts"
              title="Close"
              className="cukii-account-icon-button"
              onClick={onClose}
            >
              <XMarkIcon />
            </button>
          </div>
        </header>

        <div className="mt-1">
          {loading && accounts.length === 0 ? (
            <div className="py-4 text-[13px] text-[var(--vscode-descriptionForeground)]">
              Checking vendor CLIs…
            </div>
          ) : (
            accounts.map((account) => (
              <section
                key={account.id}
                data-testid={`cukii-vendor-account-${account.id}`}
                className="cukii-account-row"
              >
                <span
                  className={`cukii-account-state cukii-vendor-state-${account.state}`}
                  aria-label={account.state}
                />
                <span className="min-w-0 flex-1 leading-[19.5px]">
                  <span className="block text-[13px] text-[var(--vscode-foreground)]">
                    {account.label}
                  </span>
                  {account.accountLabel && (
                    <span className="block truncate text-[12px] text-[var(--vscode-descriptionForeground)]">
                      {account.accountLabel}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center">
                  {account.actions.map((action) => {
                    const key = `${account.id}:${action}`;
                    return (
                      <button
                        key={action}
                        type="button"
                        disabled={busy !== undefined}
                        className="cukii-vendor-action"
                        onClick={() => void runAction(account, action)}
                      >
                        {busy === key ? "Opening…" : ACTION_LABELS[action]}
                      </button>
                    );
                  })}
                </span>
              </section>
            ))
          )}
        </div>

        {(refreshError || actionNotice) && (
          <div className="mt-2 border-t border-[var(--vscode-widget-border)] pt-2 text-[12px] text-[var(--vscode-descriptionForeground)]">
            {refreshError && <div>{refreshError}</div>}
            {actionNotice && <div>{actionNotice}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
