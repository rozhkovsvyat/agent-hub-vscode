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
/**
 * `/users/me` is both the cheapest authenticated read and the only one that
 * says WHO the key belongs to: it answers `{ id, email, realName, … }`.
 * `/users?limit=1` proves the key works but returns the first user of the
 * company, which is not necessarily its owner — using it for the row label
 * would put someone else's address under the account.
 */
export const YOUGILE_PROBE_PATH = "/users/me";
export const YOUGILE_LOGIN_URL = "https://ru.yougile.com/";

export type YougileAuthHost = {
  openExternal(url: string): PromiseLike<boolean>;
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

/**
 * What the plugin's own secret slot holds. "suppressed" is a deliberate
 * sign-out recorded against a key the plugin does not own: it may not delete
 * the machine's token file, but "Log out" has to mean something, so it stops
 * using the discovered key until the next sign-in.
 */
type StoredRecord =
  | { kind: "account"; account: StoredYougileAccount }
  | { kind: "suppressed" };

function parseStored(raw: string | undefined): StoredRecord | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredYougileAccount> & {
      suppressed?: unknown;
    };
    // An explicit key is checked FIRST: a record carrying both a key and the
    // marker means the user signed in after signing out, and the sign-in has to
    // win — otherwise the parser would quietly contradict the rule this whole
    // module is built on.
    if (typeof parsed?.key === "string" && parsed.key) {
      return {
        kind: "account",
        account: {
          key: parsed.key,
          ...(typeof parsed.accountLabel === "string" && parsed.accountLabel
            ? { accountLabel: parsed.accountLabel }
            : {}),
          source: "plugin",
        },
      };
    }
    if (parsed?.suppressed === true) return { kind: "suppressed" };
    return undefined;
  } catch {
    // A key written by an older build was a bare string.
    return raw.trim()
      ? { kind: "account", account: { key: raw.trim(), source: "plugin" } }
      : undefined;
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
  const record = store
    ? parseStored(await store.get(YOUGILE_SECRET_KEY))
    : undefined;
  if (record?.kind === "account") return record.account;
  // A recorded sign-out wins over discovery, otherwise "Log out" would be
  // undone by the very next status read and the row would never change.
  if (record?.kind === "suppressed") return undefined;
  return readMachineToken(environment);
}

export type YougileProbe = {
  verdict: "valid" | "rejected" | "unreachable";
  /** Present only on a 2xx: the address the key actually belongs to. */
  email?: string;
};

/**
 * One call answers both questions the row asks: does this key work, and whose
 * is it. Anything but a 2xx means the key does not currently work; a transport
 * failure is reported separately so a broken network never looks like a
 * revoked key.
 */
export async function probeYougileKey(
  key: string,
  options: { http?: YougileHttp; timeoutMs?: number } = {},
): Promise<YougileProbe> {
  const http = options.http ?? defaultHttp;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 8_000,
  );
  try {
    const response = await http(`${YOUGILE_API_BASE}${YOUGILE_PROBE_PATH}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (response.ok) {
      // A body we cannot read is not a reason to call a working key broken:
      // the row simply goes without a label.
      let email: string | undefined;
      try {
        const body = (await response.json()) as { email?: unknown };
        if (typeof body?.email === "string" && body.email) email = body.email;
      } catch {
        email = undefined;
      }
      return email ? { verdict: "valid", email } : { verdict: "valid" };
    }
    // 401/403 is a real verdict about the key; a 5xx is the service, not us.
    return {
      verdict:
        response.status >= 400 && response.status < 500
          ? "rejected"
          : "unreachable",
    };
  } catch {
    return { verdict: "unreachable" };
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
  // A signed-in row offers signing out, whichever way the key was found. The
  // plugin still never deletes the machine's token file — it records the
  // sign-out and stops using it (see `logoutYougile`). Before this, a key
  // discovered on the machine produced a row that showed the account e-mail
  // and a "Log in" button at the same time, which reads as "not signed in".
  const clearable = Boolean(stored) && Boolean(options.store);
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
  const probe = await probeYougileKey(stored.key, {
    ...(options.http ? { http: options.http } : {}),
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
  const verdict = probe.verdict;
  // The address the key itself reports wins over the stored one: a key can be
  // replaced with another account's, and the row must not keep the old name.
  const label = probe.email ?? stored.accountLabel;
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
      ...(label ? { accountLabel: label } : {}),
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
    ...(label ? { accountLabel: label } : {}),
    actions: clearable ? ["logout"] : ["login"],
  };
}

export async function loginYougile(options: {
  host: YougileAuthHost;
  store?: ProtectedSecretStore;
  http?: YougileHttp;
  environment?: YougileEnvironment;
}): Promise<{ opened: boolean; message: string }> {
  // 🔴 Signing out records a marker that stops the machine's own key from being
  // used. Without a way back, one "Log out" would cost the owner the very
  // convenience discovery exists for — he would have to open
  // ~/.claude/yougile-token and paste by hand a key the machine already holds.
  // So "Log in" first offers to resume it: no browser, no prompt, one click.
  if (options.store) {
    const record = parseStored(await options.store.get(YOUGILE_SECRET_KEY));
    if (record?.kind === "suppressed") {
      const machine = readMachineToken(options.environment ?? {});
      if (machine) {
        const resumed = await probeYougileKey(
          machine.key,
          options.http ? { http: options.http } : {},
        );
        if (resumed.verdict === "valid") {
          await options.store.delete(YOUGILE_SECRET_KEY);
          return {
            opened: false,
            message: resumed.email
              ? `Using this machine's YouGile key again, signed in as ${resumed.email}.`
              : "Using this machine's YouGile key again.",
          };
        }
      }
    }
  }
  await options.host.openExternal(YOUGILE_LOGIN_URL);
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
  // 🔴 The identity is NOT asked for. `/users/me` already answers it, and a
  // typed address could disagree with the key — the row would then name an
  // account the plugin is not actually acting as. Vendors do not ask either.
  const probe = await probeYougileKey(
    key,
    options.http ? { http: options.http } : {},
  );
  if (probe.verdict === "unreachable") {
    return {
      opened: true,
      message: "Could not reach YouGile to check the key. Nothing was saved.",
    };
  }
  if (probe.verdict === "rejected") {
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
      ...(probe.email ? { accountLabel: probe.email } : {}),
      source: "plugin",
    } satisfies StoredYougileAccount),
  );
  return {
    opened: true,
    message: probe.email
      ? `Signed in to YouGile as ${probe.email}.`
      : "Signed in to YouGile.",
  };
}

export async function logoutYougile(options: {
  store?: ProtectedSecretStore;
  environment?: YougileEnvironment;
}): Promise<{ opened: boolean; message: string }> {
  if (!options.store) {
    return { opened: true, message: "Signed out of YouGile." };
  }
  // The machine's token file belongs to the vault tooling, not to this
  // extension, so signing out records the decision instead of deleting it.
  // Without this the discovered key would come straight back on the next
  // status read and the button would look broken.
  //
  // 🔴 The marker is written even when no machine key exists right now. Writing
  // it only for a key found at THIS moment would let a later
  // `yougile-cli.py auth-key` — or a VS Code restarted from a shell that
  // exports YOUGILE_TOKEN — silently undo the sign-out and put someone's
  // account back in the row, which is the same defect from the other side.
  // One write, not delete-then-write: a failure between the two would leave
  // "signed out but not suppressed", which is exactly that undo.
  await options.store.store(
    YOUGILE_SECRET_KEY,
    JSON.stringify({ suppressed: true }),
  );
  const machine = readMachineToken(options.environment ?? {});
  return {
    opened: true,
    message: machine
      ? "Signed out of YouGile. The machine key stays on disk and is ignored until you sign in again."
      : "Signed out of YouGile.",
  };
}

export async function runYougileAuthAction(
  action: BrokerVendorAuthAction,
  options: {
    host: YougileAuthHost;
    store?: ProtectedSecretStore;
    http?: YougileHttp;
    environment?: YougileEnvironment;
  },
): Promise<{ opened: boolean; message: string }> {
  if (action === "login")
    return loginYougile({
      host: options.host,
      ...(options.store ? { store: options.store } : {}),
      ...(options.http ? { http: options.http } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
  if (action === "logout")
    return logoutYougile({
      ...(options.store ? { store: options.store } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
  return {
    opened: false,
    message:
      "YouGile has no CLI to install; sign in with a personal API key instead.",
  };
}
