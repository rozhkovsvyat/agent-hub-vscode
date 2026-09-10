import { describe, expect, it, vi } from "vitest";
import {
  runYougileAuthAction,
  YOUGILE_API_BASE,
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

function authHost(credentials?: { login: string; password: string }) {
  return {
    promptCredentials: vi.fn(async () => credentials),
  };
}

function credentialHost(credentials?: { login: string; password: string }) {
  return {
    promptCredentials: vi.fn(async () => credentials),
  };
}

function loginHttp(
  options: {
    status?: number;
    key?: string;
    email?: string;
    boardVisible?: boolean;
  } = {},
): YougileHttp {
  const status = options.status ?? 200;
  const key = options.key ?? KEY;
  return vi.fn(async (url) => {
    if (url.endsWith("/auth/companies")) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => [{ id: "company-cukii", name: "Cukii" }],
      };
    }
    if (url.endsWith("/auth/keys/get")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.endsWith("/auth/keys")) {
      return { ok: true, status: 200, json: async () => ({ key }) };
    }
    if (url.includes("/boards?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content:
            options.boardVisible === false
              ? []
              : [{ id: "af617b56-a4a4-49fd-8afd-b2c3db1b0787" }],
        }),
      };
    }
    if (url.endsWith("/users/me")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ email: options.email ?? OWNER }),
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

/** No env var, no token file: discovery finds nothing. */
const noMachineToken = {
  env: {},
  homedir: () => "C:\\nobody",
  readFile: () => undefined,
};

/** The vault tooling has written its key where discovery looks for it. */
const machineWithToken = {
  env: {},
  homedir: () => "C:\\Users\\owner",
  readFile: (file: string) =>
    file === "C:\\Users\\owner\\.claude\\yougile-token"
      ? `${KEY}\n`
      : undefined,
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
    expect(status.actions).toEqual(["login"]);
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

  it("NEGATIVE CONTROL: a machine key plus an unreachable API never becomes Not logged in + Log out", async () => {
    const status = await yougileAccountStatus({
      store: store(),
      http: unreachable,
      environment: machineWithToken,
    });

    expect(status).toMatchObject({
      authenticated: false,
      state: "unknown",
      accountLabel: "Account status unavailable",
      actions: ["logout"],
    });
    expect(status.accountLabel).not.toBe("Not logged in");
  });

  it("signs in with credentials and automatically selects the company whose key sees the Cukii board", async () => {
    const secrets = store();
    const host = credentialHost({ login: OWNER, password: "typed-password" });
    const calls: Array<{ url: string; body?: string }> = [];
    const authHttp: YougileHttp = vi.fn(async (url, init) => {
      calls.push({ url, body: init.body });
      if (url.endsWith("/auth/companies")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            { id: "company-wrong", name: "Other" },
            { id: "company-cukii", name: "Cukii" },
          ],
        };
      }
      if (url.endsWith("/auth/keys/get")) {
        return {
          ok: true,
          status: 200,
          json: async () => [
            {
              key: "wrong-company-key-0123456789",
              companyId: "company-wrong",
              deleted: false,
            },
          ],
        };
      }
      if (
        url.includes("/boards?") &&
        init.headers.Authorization?.includes("wrong")
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [] }),
        };
      }
      if (url.endsWith("/auth/keys")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ key: KEY }),
        };
      }
      if (url.includes("/boards?")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ id: "af617b56-a4a4-49fd-8afd-b2c3db1b0787" }],
          }),
        };
      }
      if (url.endsWith("/users/me")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ email: OWNER }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const result = await runYougileAuthAction("login", {
      host,
      store: secrets,
      http: authHttp,
      environment: noMachineToken,
    });

    expect(host.promptCredentials).toHaveBeenCalledOnce();
    expect(JSON.parse(secrets.values.get(YOUGILE_SECRET_KEY) ?? "{}")).toEqual({
      key: KEY,
      accountLabel: OWNER,
      source: "plugin",
    });
    expect(result.message).toContain(OWNER);
    expect(calls.some(({ url }) => url.endsWith("/auth/keys"))).toBe(true);
    expect(calls.map(({ body }) => body ?? "").join("\n")).toContain(
      "typed-password",
    );
    expect([...secrets.values.values()].join("\n")).not.toContain(
      "typed-password",
    );
  });

  it("never asks for an API token or opens a token-management page", async () => {
    const host = authHost({ login: OWNER, password: "password" });
    await runYougileAuthAction("login", {
      host,
      store: store(),
      http: loginHttp(),
    });
    expect(Object.keys(host)).toEqual(["promptCredentials"]);
    expect(host).not.toHaveProperty("promptSecret");
    expect(host).not.toHaveProperty("openExternal");
  });

  it("uses the login identity while storing only the generated key", async () => {
    // A typed address could disagree with the key, and the row would then name
    // an account the plugin is not acting as. Vendors do not ask either.
    const host = authHost({ login: OWNER, password: "password" });
    await runYougileAuthAction("login", {
      host,
      store: store(),
      http: loginHttp(),
    });
    expect(host.promptCredentials).toHaveBeenCalledOnce();
    expect(Object.keys(host)).toEqual(["promptCredentials"]);
  });

  it("picks up the machine's own token and offers sign-out, never sign-in beside a live account", async () => {
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
    // 🔴 The owner's report: the row showed a green dot and his e-mail next to
    // a "Log in" button, which reads as "not signed in". A connected row offers
    // sign-out however the key was found; the plugin still never deletes the
    // machine's file — `logoutYougile` records the decision instead.
    expect(fromFile.actions).toEqual(["logout"]);
    expect(fromFile.actions).not.toContain("login");
    // It also has to say WHOSE account it is. Before the probe moved to
    // /users/me the row showed a bare "YouGile" while actually being connected.
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

  it("saves nothing when credentials are refused or the flow is cancelled", async () => {
    const refused = store();
    await runYougileAuthAction("login", {
      host: authHost({ login: OWNER, password: "wrong" }),
      store: refused,
      http: loginHttp({ status: 401 }),
    });
    expect(refused.store).not.toHaveBeenCalled();

    const cancelled = store();
    await runYougileAuthAction("login", {
      host: authHost(undefined),
      store: cancelled,
      http: loginHttp(),
    });
    expect(cancelled.store).not.toHaveBeenCalled();
  });

  it("forgets the key on sign-out", async () => {
    const secrets = store(JSON.stringify({ key: KEY, accountLabel: OWNER }));
    await runYougileAuthAction("logout", {
      host: authHost(),
      store: secrets,
      // Explicit: without it the test reads THIS machine's real token file and
      // its result depends on whose laptop runs the suite.
      environment: noMachineToken,
    });
    // The key itself is gone — the record left behind is only the marker.
    expect(JSON.parse(secrets.values.get(YOUGILE_SECRET_KEY) ?? "{}")).toEqual({
      suppressed: true,
    });
    const after = await yougileAccountStatus({
      store: secrets,
      http: http(200),
      environment: noMachineToken,
    });
    expect(after.state).toBe("disconnected");
    expect(after.accountLabel).toBeUndefined();
  });

  it("NEGATIVE CONTROL: a token appearing later does not undo the sign-out", async () => {
    // 🔴 The marker used to be written only when a machine key existed AT THAT
    // MOMENT. So signing out of a plugin key wrote nothing, and the next
    // `yougile-cli.py auth-key` — or a VS Code restarted from a shell that
    // exports YOUGILE_TOKEN — put somebody's account back in the row on its
    // own and resumed sending that key to the API. An explicit sign-out may not
    // be undone by an external event.
    const secrets = store(JSON.stringify({ key: KEY, accountLabel: OWNER }));
    await runYougileAuthAction("logout", {
      host: authHost(),
      store: secrets,
      environment: noMachineToken,
    });

    const tokenAppearsLater = {
      env: {},
      homedir: () => "C:\\Users\\owner",
      readFile: (file: string) =>
        file === "C:\\Users\\owner\\.claude\\yougile-token"
          ? `${KEY}\n`
          : undefined,
    };
    const after = await yougileAccountStatus({
      store: secrets,
      http: http(200),
      environment: tokenAppearsLater,
    });
    expect(after.state).toBe("disconnected");
    expect(after.accountLabel).toBeUndefined();
    expect(after.actions).toEqual(["login"]);
  });

  it("offers the machine key back on the next sign-in, naming the account", async () => {
    // The way back matters as much as the sign-out. Without it one "Log out"
    // would cost the owner the whole point of discovery: he would have to open
    // ~/.claude/yougile-token and paste by hand a key the machine already has.
    const secrets = store(JSON.stringify({ suppressed: true }));
    const host = {
      ...authHost({ login: OWNER, password: "password" }),
      confirmResume: vi.fn(async () => true),
    };

    const result = await runYougileAuthAction("login", {
      host,
      store: secrets,
      http: http(200),
      environment: machineWithToken,
    });

    // The offer names whose account it is — "use this key" is not a decision
    // anyone can make without knowing which account it signs them into.
    expect(host.confirmResume).toHaveBeenCalledWith(OWNER);
    // Accepted, so no credentials need to be typed.
    expect(host.promptCredentials).not.toHaveBeenCalled();
    expect(result.message).toContain(OWNER);
    expect(secrets.values.size).toBe(0);

    const after = await yougileAccountStatus({
      store: secrets,
      http: http(200),
      environment: machineWithToken,
    });
    expect(after.state).toBe("connected");
    expect(after.accountLabel).toBe(OWNER);
    expect(after.actions).toEqual(["logout"]);
  });

  it("NEGATIVE CONTROL: declining the offer still lets a different key be entered", async () => {
    // 🔴 The regression this pins. Adopting the machine's key without asking
    // made an explicit sign-in unreachable: Log out → Log in landed back on
    // that same key every time, so a second account could never be entered
    // while a valid token sat on disk. Declining must fall through to the
    // ordinary browser-and-key flow.
    const secrets = store(JSON.stringify({ suppressed: true }));
    const host = {
      promptCredentials: vi.fn(async () => ({
        login: "second@company.ru",
        password: "password",
      })),
      confirmResume: vi.fn(async () => false),
    };

    await runYougileAuthAction("login", {
      host,
      store: secrets,
      http: loginHttp({ email: "second@company.ru" }),
      environment: machineWithToken,
    });

    expect(host.confirmResume).toHaveBeenCalled();
    expect(host.promptCredentials).toHaveBeenCalledOnce();
    expect(JSON.parse(secrets.values.get(YOUGILE_SECRET_KEY) ?? "{}")).toEqual({
      key: KEY,
      accountLabel: "second@company.ru",
      source: "plugin",
    });
  });

  it("a host without resume confirmation never adopts the machine key by itself", async () => {
    // `confirmResume` is optional. Absent it, the only safe reading of "Log in"
    // is the ordinary flow — silently reusing a key nobody confirmed would be
    // the same defect through a different door.
    const secrets = store(JSON.stringify({ suppressed: true }));
    const host = authHost({ login: OWNER, password: "password" });

    await runYougileAuthAction("login", {
      host,
      store: secrets,
      http: loginHttp(),
      environment: machineWithToken,
    });

    expect(host.promptCredentials).toHaveBeenCalledOnce();
  });

  it("NEGATIVE CONTROL: a truncated record is not sent as a credential", async () => {
    // A write cut short leaves something that is neither JSON nor a key, and
    // `{"suppressed":tru` happens to pass the shape check for an opaque key.
    // Without a guard that fragment would go to the API as a Bearer token.
    const probe = http(200);
    const status = await yougileAccountStatus({
      store: store('{"suppressed":tru'),
      http: probe,
      environment: noMachineToken,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(status.state).toBe("disconnected");
  });

  it("falls back to asking when the machine key no longer works", async () => {
    // A suppressed row plus a stale token must not silently sign the user in;
    // the normal browser flow has to take over.
    const machine = {
      env: { YOUGILE_TOKEN: "stale-key-0123456789abcdef" },
      homedir: () => "C:\\nobody",
      readFile: () => undefined,
    };
    const secrets = store(JSON.stringify({ suppressed: true }));
    const host = authHost({ login: OWNER, password: "password" });
    const rejectsStale: YougileHttp = vi.fn(async (url: string, init) => {
      const stale = init?.headers?.Authorization?.includes("stale");
      if (!stale) return loginHttp()(url, init);
      return {
        ok: false,
        status: 401,
        json: async () => ({}),
      };
    });

    await runYougileAuthAction("login", {
      host,
      store: secrets,
      http: rejectsStale,
      environment: machine,
    });

    expect(host.promptCredentials).toHaveBeenCalledOnce();
    expect(JSON.parse(secrets.values.get(YOUGILE_SECRET_KEY) ?? "{}")).toEqual({
      key: KEY,
      accountLabel: OWNER,
      source: "plugin",
    });
  });

  it("an explicit key beats the marker even in one record", async () => {
    // The parser must never let a leftover marker outrank a key the user
    // actually signed in with — the rule this module is built on is that an
    // explicit sign-in wins over discovery.
    const status = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, suppressed: true })),
      http: http(200),
      environment: noMachineToken,
    });
    expect(status.state).toBe("connected");
    expect(status.accountLabel).toBe(OWNER);
  });

  it("signing out of a machine key stops using it without deleting the file", async () => {
    // The plugin may not delete ~/.claude/yougile-token — it belongs to the
    // vault tooling. But "Log out" has to mean something, otherwise the
    // discovered key returns on the very next status read and the button looks
    // broken. So the sign-out is recorded and discovery is suppressed.
    const machine = {
      env: {},
      homedir: () => "C:\\Users\\owner",
      readFile: (file: string) =>
        file === "C:\\Users\\owner\\.claude\\yougile-token"
          ? `${KEY}\n`
          : undefined,
    };
    const secrets = store();
    const result = await runYougileAuthAction("logout", {
      host: authHost(),
      store: secrets,
      environment: machine,
    });
    expect(result.opened).toBe(true);
    expect(secrets.values.size).toBe(1);

    const after = await yougileAccountStatus({
      store: secrets,
      http: http(200),
      environment: machine,
    });
    expect(after.state).toBe("disconnected");
    expect(after.actions).toEqual(["login"]);
    expect(after.accountLabel).toBeUndefined();
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
