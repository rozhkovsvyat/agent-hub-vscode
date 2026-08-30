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
  const [notice, setNotice] = useState<string>();
  const refreshInFlight = useRef(false);
  const refreshQueued = useRef(false);
  const queuedRefreshSilent = useRef(true);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(
    async (silent = false) => {
      const generation = ++refreshGeneration.current;
      if (!silent) setLoading(true);
      if (refreshInFlight.current) {
        // A later intent invalidates the pending result before it resolves.
        // Once it completes, launch a fresh native probe for the latest intent.
        refreshQueued.current = true;
        queuedRefreshSilent.current = silent;
        return;
      }
      refreshInFlight.current = true;
      try {
        const response = await ideMessenger.request(
          "cukii/listVendorAccounts",
          undefined,
        );
        if (generation !== refreshGeneration.current) return;
        if (response.status === "success") {
          setAccounts(response.content);
        } else if (!silent) {
          setNotice(response.error);
        }
      } finally {
        refreshInFlight.current = false;
        if (refreshQueued.current) {
          refreshQueued.current = false;
          void refresh(queuedRefreshSilent.current);
        } else if (generation === refreshGeneration.current) {
          setLoading(false);
        }
      }
    },
    [ideMessenger],
  );

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(true), 5_000);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, refresh]);

  const runAction = async (
    account: BrokerVendorAuthStatus,
    action: BrokerVendorAuthAction,
  ) => {
    const key = `${account.id}:${action}`;
    setBusy(key);
    try {
      const response = await ideMessenger.request("cukii/runVendorAuthAction", {
        vendor: account.id,
        action,
      });
      setNotice(
        response.status === "success" ? response.content.message : response.error,
      );
    } finally {
      setBusy(undefined);
      // Do not keep the state from before opening the native login/logout flow.
      await refresh(true);
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
              onClick={() => void refresh(false)}
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
                  <span className="block truncate text-[12px] text-[var(--vscode-descriptionForeground)]">
                    {account.accountLabel}
                  </span>
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

        {notice && (
          <div className="mt-2 border-t border-[var(--vscode-widget-border)] pt-2 text-[12px] text-[var(--vscode-descriptionForeground)]">
            {notice}
          </div>
        )}
      </div>
    </div>
  );
}
