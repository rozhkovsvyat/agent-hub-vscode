import { describe, expect, it, vi } from "vitest";
import {
  runYougileAuthAction,
  YOUGILE_API_BASE,
  YOUGILE_LOGIN_URL,
  YOUGILE_PROBE_PATH,
  YOUGILE_SECRET_KEY,
  yougileAccountStatus,
  type YougileHttp,
} from "./yougileAccount";

const KEY = "abcdefghijklmnopqrstuvwxyz0123456789";
const OWNER = "owner@company.ru";

function store(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set(YOUGILE_SECRET_KEY, initial);
  return {
    values,
    get: vi.fn(async (key: string) => values.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

/**
 * `/users/me` answers `{ id, email, realName, … }` on a 2xx. The "no address"
 * case is `null`, not `undefined`: an explicit `undefined` argument selects the
 * default parameter and would quietly hand back OWNER instead.
 */
function http(status: number, email: string | null = OWNER): YougileHttp {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (email ? { id: "u1", email } : {}),
  }));
}

const unreachable: YougileHttp = vi.fn(async () => {
  throw new Error("ENOTFOUND");
});

function authHost(key?: string) {
  return {
    openExternal: vi.fn(async () => true),
    promptSecret: vi.fn(async () => key),
  };
}

/** No env var, no token file: discovery finds nothing. */
const noMachineToken = {
  env: {},
  homedir: () => "C:\\nobody",
  readFile: () => undefined,
};

describe("YouGile account row", () => {
  it("offers only sign-in when nothing is stored", async () => {
    const status = await yougileAccountStatus({
      store: store(),
      environment: noMachineToken,
    });
    expect(status).toEqual({
      id: "yougile",
      label: "YouGile",
      group: "testing",
      installed: true,
      authenticated: false,
      state: "disconnected",
      actions: ["login"],
    });
  });

  it("reports the account the key itself belongs to", async () => {
    const probe = http(200);
    const status = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY })),
      http: probe,
      environment: noMachineToken,
    });
    // 🔴 The identity comes from /users/me, not from /users?limit=1: the latter
    // returns the first user of the company, which need not be the key's owner.
    expect(probe).toHaveBeenCalledWith(
      `${YOUGILE_API_BASE}${YOUGILE_PROBE_PATH}`,
      expect.objectContaining({ headers: { Authorization: `Bearer ${KEY}` } }),
    );
    expect(status.state).toBe("connected");
    expect(status.authenticated).toBe(true);
    expect(status.accountLabel).toBe(OWNER);
    expect(status.actions).toEqual(["logout"]);
  });

  it("prefers the address the API reports over the stored one", async () => {
    // A key can be replaced with another account's; keeping the old label would
    // name an account the plugin is no longer acting as.
    const status = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, accountLabel: "stale@old.ru" })),
      http: http(200, "fresh@company.ru"),
      environment: noMachineToken,
    });
    expect(status.accountLabel).toBe("fresh@company.ru");
  });

  it("stays usable when the probe answers 2xx without an address", async () => {
    // A body we cannot read is not a reason to call a working key broken.
    const status = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY })),
      http: http(200, null),
      environment: noMachineToken,
    });
    expect(status.state).toBe("connected");
    expect(status.accountLabel).toBeUndefined();
  });

  it("does not keep showing an account whose key the API rejects", async () => {
    const status = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, accountLabel: OWNER })),
      http: http(401),
      environment: noMachineToken,
    });
    expect(status.state).toBe("disconnected");
    expect(status.accountLabel).toBeUndefined();
    // Both, because the stored key has to be clearable as well as replaceable.
    expect(status.actions).toEqual(["login", "logout"]);
  });

  it("NEGATIVE CONTROL: an unreachable API is not a revoked key", async () => {
    // A 5xx or a dead network must not read as "signed out", or a flaky
    // connection would silently drop the user's account from the dialog.
    const offline = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, accountLabel: OWNER })),
      http: unreachable,
      environment: noMachineToken,
    });
    expect(offline.state).toBe("unknown");
    expect(offline.accountLabel).toBe(OWNER);

    const serverError = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, accountLabel: OWNER })),
      http: http(503),
      environment: noMachineToken,
    });
    expect(serverError.state).toBe("unknown");
    expect(serverError.accountLabel).toBe(OWNER);
  });

  it("opens the browser and stores the key only after the API accepts it", async () => {
    const secrets = store();
    const host = authHost(KEY);
    const probe = http(200);

    const result = await runYougileAuthAction("login", {
      host,
      store: secrets,
      http: probe,
    });

    expect(host.openExternal).toHaveBeenCalledWith(YOUGILE_LOGIN_URL);
    expect(probe).toHaveBeenCalledWith(
      `${YOUGILE_API_BASE}${YOUGILE_PROBE_PATH}`,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    );
    expect(JSON.parse(secrets.values.get(YOUGILE_SECRET_KEY) ?? "{}")).toEqual({
      key: KEY,
      accountLabel: OWNER,
      source: "plugin",
    });
    expect(result.message).toContain(OWNER);
  });

  it("never asks the user to type the identity", async () => {
    // A typed address could disagree with the key, and the row would then name
    // an account the plugin is not acting as. Vendors do not ask either.
    const host = authHost(KEY);
    await runYougileAuthAction("login", {
      host,
      store: store(),
      http: http(200),
    });
    expect(host).not.toHaveProperty("promptEmail");
    expect(Object.keys(host)).toEqual(["openExternal", "promptSecret"]);
  });

  it("picks up the machine's own token but never offers to delete it", async () => {
    // The vault tooling (`yougile-cli.py auth-key`) writes the key to
    // ~/.claude/yougile-token, and YOUGILE_TOKEN is its documented override.
    // A row that ignored them would ask an already-authenticated user to
    // re-enter a key the machine already has.
    const fromFile = await yougileAccountStatus({
      store: store(),
      http: http(200),
      environment: {
        env: {},
        homedir: () => "C:\\Users\\owner",
        readFile: (file) =>
          file === "C:\\Users\\owner\\.claude\\yougile-token"
            ? `${KEY}\n`
            : undefined,
      },
    });
    expect(fromFile.state).toBe("connected");
    // No sign-out: the plugin did not write that key and must not delete it.
    expect(fromFile.actions).toEqual(["login"]);
    // 🔴 It still has to say WHOSE account it is. Before the probe moved to
    // /users/me the row showed a bare "YouGile" next to a "Log in" button while
    // actually being connected — it read as signed out. Caught by measuring the
    // installed 2.0.101 in a trusted instance, not by this suite.
    expect(fromFile.accountLabel).toBe(OWNER);

    const fromEnv = await yougileAccountStatus({
      store: store(),
      http: http(200),
      environment: {
        env: { YOUGILE_TOKEN: KEY },
        homedir: () => "C:\\nobody",
        readFile: () => undefined,
      },
    });
    expect(fromEnv.state).toBe("connected");
    expect(fromEnv.accountLabel).toBe(OWNER);
  });

  it("prefers the key signed in here over the machine's", async () => {
    const probe = http(200);
    const status = await yougileAccountStatus({
      store: store(
        JSON.stringify({
          key: "plugin-owned-key-0123456789",
          accountLabel: OWNER,
        }),
      ),
      http: probe,
      environment: {
        env: { YOUGILE_TOKEN: KEY },
        homedir: () => "C:\\nobody",
        readFile: () => undefined,
      },
    });
    expect(probe).toHaveBeenCalledWith(
      `${YOUGILE_API_BASE}${YOUGILE_PROBE_PATH}`,
      expect.objectContaining({
        headers: { Authorization: "Bearer plugin-owned-key-0123456789" },
      }),
    );
    expect(status.actions).toEqual(["logout"]);
  });

  it("saves nothing when the key is refused or the flow is cancelled", async () => {
    const refused = store();
    await runYougileAuthAction("login", {
      host: authHost(KEY),
      store: refused,
      http: http(401),
    });
    expect(refused.store).not.toHaveBeenCalled();

    const cancelled = store();
    await runYougileAuthAction("login", {
      host: authHost(undefined),
      store: cancelled,
      http: http(200),
    });
    expect(cancelled.store).not.toHaveBeenCalled();

    const junk = store();
    await runYougileAuthAction("login", {
      host: authHost("short"),
      store: junk,
      http: http(200),
    });
    expect(junk.store).not.toHaveBeenCalled();
  });

  it("forgets the key on sign-out", async () => {
    const secrets = store(JSON.stringify({ key: KEY, accountLabel: OWNER }));
    await runYougileAuthAction("logout", {
      host: authHost(),
      store: secrets,
    });
    expect(secrets.delete).toHaveBeenCalledWith(YOUGILE_SECRET_KEY);
    expect(secrets.values.size).toBe(0);
  });

  it("says plainly that there is no CLI to install", async () => {
    const result = await runYougileAuthAction("install", {
      host: authHost(),
      store: store(),
    });
    expect(result.opened).toBe(false);
    expect(result.message).toContain("no CLI");
  });
});
