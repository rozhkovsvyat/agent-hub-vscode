import type {
  BrokerVendorAuthAction,
  BrokerVendorAuthStatus,
} from "core/protocol/ideWebview";
import type { ProtectedSecretStore } from "./alibabaTokenPlan";

/**
 * YouGile is the first non-vendor account: it carries no model catalog and
 * exists so the plugin can file bug-hunt cards on a board the user already has
 * access to. It wears the same row contract as a vendor — probe, log in, log
 * out, account label — under a separate "Testing" group.
 *
 * There is deliberately no Install action. YouGile publishes no CLI: the npm
 * registry has only the `yougile` SDK (no `bin`) and third-party MCP servers,
 * so an "install the CLI" button would have nothing to install. Authentication
 * is the vendor's own documented one — a personal API key against REST v2,
 * created in the YouGile web UI, which is why login still opens the browser.
 */
export const YOUGILE_ACCOUNT_ID = "yougile" as const;
export const YOUGILE_ACCOUNT_LABEL = "YouGile";
export const YOUGILE_SECRET_KEY = "cukii.yougile.apiKey";
export const YOUGILE_API_BASE = "https://ru.yougile.com/api-v2";
export const YOUGILE_LOGIN_URL = "https://ru.yougile.com/";

export type YougileAuthHost = {
  openExternal(url: string): PromiseLike<boolean>;
  promptEmail(): PromiseLike<string | undefined>;
  promptSecret(): PromiseLike<string | undefined>;
};

/** Only what this module needs from fetch, so tests never touch the network. */
export type YougileHttp = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type StoredYougileAccount = {
  key: string;
  accountLabel?: string;
};

const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isYougileAccountId(
  id: string,
): id is typeof YOUGILE_ACCOUNT_ID {
  return id === YOUGILE_ACCOUNT_ID;
}

/**
 * A YouGile key is an opaque string; the only thing worth rejecting locally is
 * something that cannot be a header value at all. The API itself is the
 * authority, and it is called before anything is stored.
 */
export function looksLikeYougileKey(value: string): boolean {
  const key = value.trim();
  if (key.length < 16 || key.length > 512) return false;
  return !/[\x00-\x1f\x7f\s]/.test(key);
}

export function isYougileEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

function parseStored(
  raw: string | undefined,
): StoredYougileAccount | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredYougileAccount>;
    if (typeof parsed?.key !== "string" || !parsed.key) return undefined;
    return {
      key: parsed.key,
      ...(typeof parsed.accountLabel === "string" && parsed.accountLabel
        ? { accountLabel: parsed.accountLabel }
        : {}),
    };
  } catch {
    // A key written by an older build was a bare string.
    return raw.trim() ? { key: raw.trim() } : undefined;
  }
}

export async function readYougileAccount(
  store: ProtectedSecretStore | undefined,
): Promise<StoredYougileAccount | undefined> {
  if (!store) return undefined;
  return parseStored(await store.get(YOUGILE_SECRET_KEY));
}

/**
 * `GET /users` is the cheapest authenticated read the key can do. Anything but
 * a 2xx means the key does not currently work, which is exactly what the row
 * has to report; a transport failure is reported separately so a broken
 * network never looks like a revoked key.
 */
export async function verifyYougileKey(
  key: string,
  options: { http?: YougileHttp; timeoutMs?: number } = {},
): Promise<"valid" | "rejected" | "unreachable"> {
  const http = options.http ?? defaultHttp;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 8_000,
  );
  try {
    const response = await http(`${YOUGILE_API_BASE}/users?limit=1`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (response.ok) return "valid";
    // 401/403 is a real verdict about the key; a 5xx is the service, not us.
    return response.status >= 400 && response.status < 500
      ? "rejected"
      : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

const defaultHttp: YougileHttp = (url, init) =>
  fetch(url, { headers: init.headers, signal: init.signal });

export async function yougileAccountStatus(
  options: {
    store?: ProtectedSecretStore;
    http?: YougileHttp;
    timeoutMs?: number;
  } = {},
): Promise<BrokerVendorAuthStatus> {
  const stored = await readYougileAccount(options.store);
  if (!stored) {
    return {
      id: YOUGILE_ACCOUNT_ID,
      label: YOUGILE_ACCOUNT_LABEL,
      group: "testing",
      installed: true,
      authenticated: false,
      state: "disconnected",
      actions: ["login"],
    };
  }
  const verdict = await verifyYougileKey(stored.key, {
    ...(options.http ? { http: options.http } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
  if (verdict === "unreachable") {
    // The stored identity is still the truth we know; only its freshness is
    // unknown, so the row keeps the account and says so through its state.
    return {
      id: YOUGILE_ACCOUNT_ID,
      label: YOUGILE_ACCOUNT_LABEL,
      group: "testing",
      installed: true,
      authenticated: false,
      state: "unknown",
      ...(stored.accountLabel ? { accountLabel: stored.accountLabel } : {}),
      actions: ["logout"],
    };
  }
  if (verdict === "rejected") {
    return {
      id: YOUGILE_ACCOUNT_ID,
      label: YOUGILE_ACCOUNT_LABEL,
      group: "testing",
      installed: true,
      authenticated: false,
      state: "disconnected",
      actions: ["login", "logout"],
    };
  }
  return {
    id: YOUGILE_ACCOUNT_ID,
    label: YOUGILE_ACCOUNT_LABEL,
    group: "testing",
    installed: true,
    authenticated: true,
    state: "connected",
    ...(stored.accountLabel ? { accountLabel: stored.accountLabel } : {}),
    actions: ["logout"],
  };
}

export async function loginYougile(options: {
  host: YougileAuthHost;
  store?: ProtectedSecretStore;
  http?: YougileHttp;
}): Promise<{ opened: boolean; message: string }> {
  await options.host.openExternal(YOUGILE_LOGIN_URL);
  const email = (await options.host.promptEmail())?.trim();
  if (!email) {
    return { opened: true, message: "YouGile sign-in cancelled." };
  }
  if (!isYougileEmail(email)) {
    return { opened: true, message: "That is not a valid e-mail address." };
  }
  const key = (await options.host.promptSecret())?.trim();
  if (!key) {
    return { opened: true, message: "YouGile sign-in cancelled." };
  }
  if (!looksLikeYougileKey(key)) {
    return {
      opened: true,
      message: "That does not look like a YouGile API key.",
    };
  }
  const verdict = await verifyYougileKey(
    key,
    options.http ? { http: options.http } : {},
  );
  if (verdict === "unreachable") {
    return {
      opened: true,
      message: "Could not reach YouGile to check the key. Nothing was saved.",
    };
  }
  if (verdict === "rejected") {
    return {
      opened: true,
      message: "YouGile rejected that API key. Nothing was saved.",
    };
  }
  if (!options.store) {
    return {
      opened: true,
      message: "No secret storage is available to save the YouGile key.",
    };
  }
  await options.store.store(
    YOUGILE_SECRET_KEY,
    JSON.stringify({ key, accountLabel: email } satisfies StoredYougileAccount),
  );
  return { opened: true, message: `Signed in to YouGile as ${email}.` };
}

export async function logoutYougile(options: {
  store?: ProtectedSecretStore;
}): Promise<{ opened: boolean; message: string }> {
  await options.store?.delete(YOUGILE_SECRET_KEY);
  return { opened: true, message: "Signed out of YouGile." };
}

export async function runYougileAuthAction(
  action: BrokerVendorAuthAction,
  options: {
    host: YougileAuthHost;
    store?: ProtectedSecretStore;
    http?: YougileHttp;
  },
): Promise<{ opened: boolean; message: string }> {
  if (action === "login") return loginYougile(options);
  if (action === "logout") return logoutYougile({ store: options.store });
  return {
    opened: false,
    message:
      "YouGile has no CLI to install; sign in with a personal API key instead.",
  };
}
