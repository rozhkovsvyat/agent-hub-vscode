import type {
  BrokerVendorAuthAction,
  BrokerVendorAuthStatus,
} from "core/protocol/ideWebview";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ProtectedSecretStore } from "./alibabaTokenPlan";

/**
 * YouGile is the first non-vendor account: it carries no model catalog and
 * exists so the plugin can file bug-hunt cards on a board the user already has
 * access to. It wears the same row contract as a vendor — probe, log in, log
 * out, account label — under a separate "Testing" group.
 *
 * There is deliberately no Install action. YouGile ships no CLI to install:
 * the npm registry has only the `yougile` SDK (no `bin`) and third-party MCP
 * servers. Authentication is the vendor's own documented one — a personal API
 * key against REST v2 — which is why login opens the browser and then asks for
 * the key. The machine's existing `yougile-cli.py auth-key` convention
 * (`YOUGILE_TOKEN`, then `~/.claude/yougile-token`) is honoured as-is, so an
 * already-authenticated workstation is not asked to paste a key it has.
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
  /**
   * "plugin" — signed in here, so the plugin owns the key and can drop it.
   * "machine" — discovered through the convention the vault tooling already
   * uses (`YOUGILE_TOKEN`, then `~/.claude/yougile-token`, written by
   * `yougile-cli.py auth-key`). That key belongs to the machine, not to this
   * extension, so the row reports it but never offers to delete it.
   */
  source: "plugin" | "machine";
};

export const YOUGILE_TOKEN_ENV = "YOUGILE_TOKEN";
export const YOUGILE_TOKEN_FILE = ".claude/yougile-token";

export type YougileEnvironment = {
  env?: Record<string, string | undefined>;
  homedir?: () => string;
  readFile?: (file: string) => string | undefined;
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
      source: "plugin",
    };
  } catch {
    // A key written by an older build was a bare string.
    return raw.trim() ? { key: raw.trim(), source: "plugin" } : undefined;
  }
}

function readMachineToken(
  environment: YougileEnvironment = {},
): StoredYougileAccount | undefined {
  const env = environment.env ?? process.env;
  const fromEnv = env[YOUGILE_TOKEN_ENV]?.trim();
  if (fromEnv) return { key: fromEnv, source: "machine" };
  const home = (environment.homedir ?? os.homedir)();
  const file = path.join(home, ...YOUGILE_TOKEN_FILE.split("/"));
  const read =
    environment.readFile ??
    ((target: string) => {
      try {
        return fs.readFileSync(target, "utf8");
      } catch {
        return undefined;
      }
    });
  const fromFile = read(file)?.trim();
  return fromFile ? { key: fromFile, source: "machine" } : undefined;
}

/**
 * An explicit sign-in here beats discovery: the plugin's own key is the one
 * the user last chose, and it is the only one the plugin may delete.
 */
export async function readYougileAccount(
  store: ProtectedSecretStore | undefined,
  environment: YougileEnvironment = {},
): Promise<StoredYougileAccount | undefined> {
  const stored = store
    ? parseStored(await store.get(YOUGILE_SECRET_KEY))
    : undefined;
  return stored ?? readMachineToken(environment);
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
    environment?: YougileEnvironment;
  } = {},
): Promise<BrokerVendorAuthStatus> {
  const stored = await readYougileAccount(
    options.store,
    options.environment ?? {},
  );
  // A key the plugin did not write is not the plugin's to delete, so no
  // sign-out is offered for it — signing in here replaces it instead.
  const clearable = stored?.source === "plugin";
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
      actions: clearable ? ["logout"] : ["login"],
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
      actions: clearable ? ["login", "logout"] : ["login"],
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
    actions: clearable ? ["logout"] : ["login"],
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
    JSON.stringify({
      key,
      accountLabel: email,
      source: "plugin",
    } satisfies StoredYougileAccount),
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
