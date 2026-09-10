import { ArrowPathIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type {
  BrokerVendorAuthAction,
  BrokerVendorAuthStatus,
} from "core/protocol/ideWebview";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { CukiiCrumbs } from "../cukii/CukiiCrumbs";

interface VendorAccountsModalProps {
  onClose: () => void;
}

type RefreshReason = "initial" | "user" | "action";

const ACTION_LABELS: Record<BrokerVendorAuthAction, string> = {
  install: "Install",
  login: "Log in",
  logout: "Log out",
};

/**
 * The subtitle and the action must describe the same account state. Hosts may
 * be older than the webview, and a transient probe failure may produce an
 * unknown state without an identity, so the renderer defends the invariant as
 * well as the extension host.
 */
export function accountStatusSubtitle(
  account: BrokerVendorAuthStatus,
): string | undefined {
  const label = account.accountLabel?.trim();
  if (account.state === "connected") {
    return label === "Not logged in" ? undefined : label;
  }
  if (account.state === "unknown") {
    return label && label !== "Not logged in"
      ? label
      : "Account status unavailable";
  }
  if (account.state === "disconnected") return "Not logged in";
  return label;
}

export function accountStatusActions(
  account: BrokerVendorAuthStatus,
): BrokerVendorAuthAction[] {
  const allowed = new Set<BrokerVendorAuthAction>(
    account.state === "connected"
      ? ["logout"]
      : account.state === "disconnected"
        ? ["login"]
        : account.state === "unavailable"
          ? ["install"]
          : account.state === "unknown"
            ? account.actions.includes("logout")
              ? ["logout"]
              : ["login"]
            : [],
  );
  return account.actions.filter((action) => allowed.has(action));
}

/**
 * Model vendors first, then accounts the plugin keeps for its own features.
 * A group with no rows is not rendered, so a host that predates grouping (all
 * rows default to "vendor") looks exactly as it did.
 */
const ACCOUNT_GROUPS: ReadonlyArray<{
  id: NonNullable<BrokerVendorAuthStatus["group"]>;
  label: string;
}> = [
  { id: "vendor", label: "Vendors" },
  { id: "testing", label: "Testing" },
];

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
        waiters: Array<() => void>;
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
          await new Promise<void>((resolve) => {
            pendingExplicitRefresh.current = {
              reason,
              generation,
              waiters: [
                ...(pendingExplicitRefresh.current?.waiters ?? []),
                resolve,
              ],
            };
          });
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
          try {
            await refresh(queuedExplicit.reason, queuedExplicit.generation);
          } finally {
            queuedExplicit.waiters.forEach((resolve) => resolve());
          }
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
    pendingExplicitRefresh.current?.waiters.forEach((resolve) => resolve());
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
      // Do not keep the state from before opening the native login/logout flow.
      // The action is not visually complete until this authoritative snapshot
      // lands: clearing `busy` first made the spinner disappear 1–2 seconds
      // before the account row caught up.
      try {
        await refresh("action");
      } finally {
        setBusy(undefined);
      }
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
              Checking CLIs…
            </div>
          ) : (
            ACCOUNT_GROUPS.map(({ id, label }) => {
              const rows = accounts.filter(
                (account) => (account.group ?? "vendor") === id,
              );
              if (rows.length === 0) return null;
              return (
                <div key={id} data-testid={`cukii-account-group-${id}`}>
                  {/* Same heading as the model picker's vendor sections. */}
                  <div className="cukii-picker-section-header cursor-default select-none">
                    {label}
                  </div>
                  {rows.map((account) => {
                    const subtitle = accountStatusSubtitle(account);
                    const actions = accountStatusActions(account);
                    return (
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
                          {/* The identity line always says something once the CLI is
                      there: the account, or that nobody is signed in. Only a
                      missing CLI leaves it blank, because "not logged in"
                      would be the wrong diagnosis. */}
                          {subtitle && (
                            <span className="block truncate text-[12px] text-[var(--vscode-descriptionForeground)]">
                              {subtitle}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center">
                          {actions.map((action) => {
                            const key = `${account.id}:${action}`;
                            const isBusy = busy === key;
                            return (
                              <button
                                key={action}
                                type="button"
                                disabled={busy !== undefined}
                                className="cukii-vendor-action"
                                aria-busy={isBusy}
                                title={
                                  isBusy
                                    ? "Waiting for the authentication flow to finish"
                                    : undefined
                                }
                                onClick={() => void runAction(account, action)}
                              >
                                {isBusy ? (
                                  <CukiiCrumbs />
                                ) : (
                                  ACTION_LABELS[action]
                                )}
                              </button>
                            );
                          })}
                        </span>
                      </section>
                    );
                  })}
                </div>
              );
            })
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
