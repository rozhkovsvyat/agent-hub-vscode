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
 * There is deliberately no Install action. YouGile ships no CLI to install.
 * YouGile has no OAuth redirect, so Log in opens the same app other vendors
 * would open and waits for the key the product copies with Ctrl+~. Email and
 * password stay a fallback for hosts that cannot open a browser. The machine's
 * existing `yougile-cli.py auth-key` convention (`YOUGILE_TOKEN`, then
 * `~/.claude/yougile-token`) is honoured as-is, so an already-authenticated
 * workstation is not asked for a key it already has.
 */
export const YOUGILE_ACCOUNT_ID = "yougile" as const;
export const YOUGILE_ACCOUNT_LABEL = "YouGile";
export const YOUGILE_SECRET_KEY = "cukii.yougile.apiKey";
export const YOUGILE_API_BASE = "https://ru.yougile.com/api-v2";
export const YOUGILE_APP_URL = "https://ru.yougile.com";
/**
 * `/users/me` is both the cheapest authenticated read and the only one that
 * says WHO the key belongs to: it answers `{ id, email, realName, … }`.
 * `/users?limit=1` proves the key works but returns the first user of the
 * company, which is not necessarily its owner — using it for the row label
 * would put someone else's address under the account.
 */
export const YOUGILE_PROBE_PATH = "/users/me";
const CUKII_BUGS_PROJECT_ID = "945711d1-c885-4c95-9b88-73a8647d0756";
const CUKII_BUGS_BOARD_ID = "af617b56-a4a4-49fd-8afd-b2c3db1b0787";

export type YougileAuthHost = {
  promptCredentials(): PromiseLike<
    { login: string; password: string } | undefined
  >;
  /**
   * After a recorded sign-out, offer to use the key this machine already holds
   * instead of typing one. 🔴 It has to be a question. Adopting that key on its
   * own would make an explicit sign-in unreachable: every "Log in" would land
   * back on the machine's key and a different account could never be entered.
   * A host that cannot ask simply omits this, and the normal flow runs.
   */
  confirmResume?(account: string | undefined): PromiseLike<boolean>;
  openExternal?(url: string): PromiseLike<boolean>;
  readClipboard?(): PromiseLike<string>;
};

export type YougileAuthPoll = {
  intervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Only what this module needs from fetch, so tests never touch the network. */
export type YougileHttp = (
  url: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
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
 * Clipboard capture is noisier than a dedicated password field. Require the
 * charset YouGile actually issues so a random copied URL does not get sent as
 * a Bearer credential.
 */
export function extractYougileKey(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "");
  if (
    looksLikeYougileKey(trimmed) &&
    trimmed.length >= 24 &&
    /^[A-Za-z0-9_-]+$/.test(trimmed)
  ) {
    return trimmed;
  }
  const embedded = trimmed.match(/\b[A-Za-z0-9_-]{24,512}\b/);
  return embedded && looksLikeYougileKey(embedded[0])
    ? embedded[0]
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    // A key written by an older build was a bare string. 🔴 A record truncated
    // mid-write parses as neither, and `{"suppressed":tru` happens to look like
    // an opaque key — without this guard that fragment would be sent to
    // ru.yougile.com as a Bearer credential.
    const bare = raw.trim();
    return bare.startsWith("{") || !looksLikeYougileKey(bare)
      ? undefined
      : { kind: "account", account: { key: bare, source: "plugin" } };
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
  fetch(url, {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });

async function yougileBoardAccess(
  key: string,
  http: YougileHttp,
): Promise<"visible" | "hidden" | "rejected" | "unreachable"> {
  const query = new URLSearchParams({
    projectId: CUKII_BUGS_PROJECT_ID,
    limit: "1000",
  });
  try {
    const response = await http(`${YOUGILE_API_BASE}/boards?${query.toString()}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.status === 401 || response.status === 403) return "rejected";
    if (!response.ok) return "unreachable";
    const body = await response.json();
    return responseItems(body).some(
      (board) => (board as { id?: unknown }).id === CUKII_BUGS_BOARD_ID,
    )
      ? "visible"
      : "hidden";
  } catch {
    return "unreachable";
  }
}

async function persistPluginYougileKey(
  store: ProtectedSecretStore,
  key: string,
  email?: string,
): Promise<{ opened: boolean; message: string }> {
  await store.store(
    YOUGILE_SECRET_KEY,
    JSON.stringify({
      key,
      ...(email ? { accountLabel: email } : {}),
      source: "plugin",
    } satisfies StoredYougileAccount),
  );
  return {
    opened: true,
    message: email
      ? `Signed in to YouGile as ${email}.`
      : "Signed in to YouGile.",
  };
}

async function adoptYougileKey(
  key: string,
  store: ProtectedSecretStore,
  http: YougileHttp,
): Promise<{ opened: boolean; message: string } | undefined> {
  const probe = await probeYougileKey(key, { http });
  if (probe.verdict === "unreachable") return undefined;
  if (probe.verdict === "rejected") {
    return {
      opened: true,
      message: "YouGile rejected that key. Nothing was saved.",
    };
  }
  const board = await yougileBoardAccess(key, http);
  if (board === "unreachable") return undefined;
  if (board === "rejected") {
    return {
      opened: true,
      message: "YouGile rejected that key. Nothing was saved.",
    };
  }
  if (board === "hidden") {
    return {
      opened: true,
      message:
        "Signed in, but none of this account's companies can see the Cukii Bugs board. Nothing was saved.",
    };
  }
  return persistPluginYougileKey(store, key, probe.email);
}

function responseItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = (value as { content?: unknown } | undefined)?.content;
  return Array.isArray(items) ? items : [];
}

type YougileCredentialExchange =
  | { verdict: "valid"; key: string; email?: string }
  | { verdict: "rejected" }
  | { verdict: "unreachable" }
  | { verdict: "board_unavailable" };

async function exchangeYougileCredentials(
  credentials: { login: string; password: string },
  http: YougileHttp,
): Promise<YougileCredentialExchange> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const jsonRequest = async (
    route: string,
    method: "GET" | "POST" | "DELETE",
    options: { body?: unknown; key?: string } = {},
  ) => {
    const response = await http(`${YOUGILE_API_BASE}${route}`, {
      method,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.key ? { Authorization: `Bearer ${options.key}` } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { response, body };
  };
  const boardVerdict = async (
    key: string,
  ): Promise<"visible" | "hidden" | "rejected" | "unreachable"> => {
    const query = new URLSearchParams({
      projectId: CUKII_BUGS_PROJECT_ID,
      limit: "1000",
    });
    try {
      const { response, body } = await jsonRequest(
        `/boards?${query.toString()}`,
        "GET",
        { key },
      );
      if (response.status === 401 || response.status === 403) return "rejected";
      if (!response.ok) return "unreachable";
      return responseItems(body).some(
        (board) => (board as { id?: unknown }).id === CUKII_BUGS_BOARD_ID,
      )
        ? "visible"
        : "hidden";
    } catch {
      return "unreachable";
    }
  };

  try {
    const authBody = {
      login: credentials.login,
      password: credentials.password,
    };
    const companyItems: unknown[] = [];
    const companyPageLimit = 1_000;
    let companyOffset = 0;
    for (let page = 0; page < 100; page += 1) {
      const companiesResult = await jsonRequest(
        `/auth/companies?limit=${companyPageLimit}&offset=${companyOffset}`,
        "POST",
        { body: authBody },
      );
      if (
        companiesResult.response.status === 401 ||
        companiesResult.response.status === 403
      ) {
        return { verdict: "rejected" };
      }
      if (!companiesResult.response.ok) return { verdict: "unreachable" };
      const pageItems = responseItems(companiesResult.body);
      companyItems.push(...pageItems);
      const hasNext =
        (companiesResult.body as { paging?: { next?: unknown } } | undefined)
          ?.paging?.next === true;
      if (!hasNext) break;
      if (pageItems.length === 0) return { verdict: "unreachable" };
      companyOffset += pageItems.length;
      if (page === 99) return { verdict: "unreachable" };
    }
    const companies = companyItems
      .map((company) => ({
        id: (company as { id?: unknown }).id,
        name: (company as { name?: unknown }).name,
      }))
      .filter(
        (company): company is { id: string; name: unknown } =>
          typeof company.id === "string" && Boolean(company.id),
      );
    if (companies.length === 0) return { verdict: "board_unavailable" };

    const keysResult = await jsonRequest("/auth/keys/get", "POST", {
      body: authBody,
    });
    if (
      keysResult.response.status === 401 ||
      keysResult.response.status === 403
    ) {
      return { verdict: "rejected" };
    }
    if (!keysResult.response.ok) return { verdict: "unreachable" };
    const existing = responseItems(keysResult.body)
      .map((entry) => ({
        key: (entry as { key?: unknown }).key,
        companyId: (entry as { companyId?: unknown }).companyId,
        deleted: (entry as { deleted?: unknown }).deleted,
      }))
      .filter(
        (
          entry,
        ): entry is {
          key: string;
          companyId: unknown;
          deleted: unknown;
        } =>
          typeof entry.key === "string" &&
          looksLikeYougileKey(entry.key) &&
          entry.deleted !== true,
      );

    let sawUnreachable = false;
    const companiesWithUsableKey = new Set<string>();
    for (const candidate of existing) {
      const verdict = await boardVerdict(candidate.key);
      if (verdict === "visible") {
        const identity = await probeYougileKey(candidate.key, { http });
        return {
          verdict: "valid",
          key: candidate.key,
          ...(identity.email ? { email: identity.email } : {}),
        };
      }
      if (verdict === "unreachable") sawUnreachable = true;
      if (verdict !== "rejected" && typeof candidate.companyId === "string") {
        companiesWithUsableKey.add(candidate.companyId);
      }
    }

    for (const company of companies) {
      if (companiesWithUsableKey.has(company.id)) continue;
      const created = await jsonRequest("/auth/keys", "POST", {
        body: { ...authBody, companyId: company.id },
      });
      if (!created.response.ok) {
        if (created.response.status >= 500) sawUnreachable = true;
        continue;
      }
      const key = (created.body as { key?: unknown } | undefined)?.key;
      if (typeof key !== "string" || !looksLikeYougileKey(key)) continue;
      const verdict = await boardVerdict(key);
      if (verdict === "visible") {
        const identity = await probeYougileKey(key, { http });
        return {
          verdict: "valid",
          key,
          ...(identity.email ? { email: identity.email } : {}),
        };
      }
      if (verdict === "unreachable") sawUnreachable = true;
      // This key was created only for discovery and cannot file Cukii reports.
      // Remove it best-effort; failure must not hide a later matching company.
      await jsonRequest(`/auth/keys/${encodeURIComponent(key)}`, "DELETE", {
        key,
      }).catch(() => undefined);
    }
    return {
      verdict: sawUnreachable ? "unreachable" : "board_unavailable",
    };
  } catch {
    return { verdict: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

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
    // If this is a machine-discovered key there may be no cached identity yet;
    // still never let the GUI infer "Not logged in" beside a Log out action.
    return {
      id: YOUGILE_ACCOUNT_ID,
      label: YOUGILE_ACCOUNT_LABEL,
      group: "testing",
      installed: true,
      authenticated: false,
      state: "unknown",
      accountLabel: label ?? "Account status unavailable",
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
      // A rejected credential is not a signed-in account. Replacing it is the
      // only useful next action; offering Log out beside "Not logged in" is a
      // contradictory state and was observed in the installed UI.
      actions: ["login"],
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
    // Without a protected store we cannot persist a sign-out decision for a
    // machine-owned key. No action is more truthful than offering Log in next
    // to an already connected account.
    actions: clearable ? ["logout"] : [],
  };
}

export async function loginYougile(options: {
  host: YougileAuthHost;
  store?: ProtectedSecretStore;
  http?: YougileHttp;
  environment?: YougileEnvironment;
  poll?: YougileAuthPoll;
}): Promise<{ opened: boolean; message: string }> {
  // 🔴 Signing out records a marker that stops the machine's own key from being
  // used. Without a way back, one "Log out" would cost the owner the very
  // convenience discovery exists for — he would have to open
  // ~/.claude/yougile-token and paste by hand a key the machine already holds.
  // So "Log in" OFFERS to resume it. Offers, not takes: adopting it silently
  // made the explicit path unreachable, because every "Log in" would land back
  // on that same key and a different account could never be entered at all.
  if (options.store && options.host.confirmResume) {
    const record = parseStored(await options.store.get(YOUGILE_SECRET_KEY));
    if (record?.kind === "suppressed") {
      const machine = readMachineToken(options.environment ?? {});
      if (machine) {
        const resumed = await probeYougileKey(
          machine.key,
          options.http ? { http: options.http } : {},
        );
        if (
          resumed.verdict === "valid" &&
          (await options.host.confirmResume(resumed.email))
        ) {
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
  if (
    options.store &&
    options.host.openExternal &&
    options.host.readClipboard
  ) {
    await options.host.openExternal(YOUGILE_APP_URL);
    const intervalMs = options.poll?.intervalMs ?? 1_000;
    const timeoutMs = options.poll?.timeoutMs ?? 180_000;
    const sleep = options.poll?.sleep ?? delay;
    const http = options.http ?? defaultHttp;
    const started = Date.now();
    for (;;) {
      const key = extractYougileKey(await options.host.readClipboard());
      if (key) {
        const adopted = await adoptYougileKey(key, options.store, http);
        if (adopted) return adopted;
      }
      if (Date.now() - started >= timeoutMs) break;
      await sleep(intervalMs);
    }
    return {
      opened: true,
      message:
        "YouGile opened in your browser. Copy the API key (Ctrl+~) and choose Log in again.",
    };
  }

  const credentials = await options.host.promptCredentials();
  const login = credentials?.login.trim() ?? "";
  const password = credentials?.password ?? "";
  if (!login || !password) {
    return { opened: true, message: "YouGile sign-in cancelled." };
  }
  if (!options.store) {
    return {
      opened: true,
      message: "No secret storage is available to save the YouGile account.",
    };
  }
  const exchange = await exchangeYougileCredentials(
    { login, password },
    options.http ?? defaultHttp,
  );
  if (exchange.verdict === "unreachable") {
    return {
      opened: true,
      message: "Could not reach YouGile. Nothing was saved.",
    };
  }
  if (exchange.verdict === "rejected") {
    return {
      opened: true,
      message: "YouGile rejected that email or password. Nothing was saved.",
    };
  }
  if (exchange.verdict === "board_unavailable") {
    return {
      opened: true,
      message:
        "Signed in, but none of this account's companies can see the Cukii Bugs board. Nothing was saved.",
    };
  }
  return persistPluginYougileKey(
    options.store,
    exchange.key,
    exchange.email ?? login,
  );
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
    poll?: YougileAuthPoll;
  },
): Promise<{ opened: boolean; message: string }> {
  if (action === "login")
    return loginYougile({
      host: options.host,
      ...(options.store ? { store: options.store } : {}),
      ...(options.http ? { http: options.http } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.poll ? { poll: options.poll } : {}),
    });
  if (action === "logout")
    return logoutYougile({
      ...(options.store ? { store: options.store } : {}),
      ...(options.environment ? { environment: options.environment } : {}),
    });
  return {
    opened: false,
    message: "YouGile has no CLI to install; use the Log in action instead.",
  };
}
