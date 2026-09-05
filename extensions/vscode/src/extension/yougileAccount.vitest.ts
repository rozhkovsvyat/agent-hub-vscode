import { describe, expect, it, vi } from "vitest";
import {
  runYougileAuthAction,
  YOUGILE_API_BASE,
  YOUGILE_LOGIN_URL,
  YOUGILE_SECRET_KEY,
  yougileAccountStatus,
  type YougileHttp,
} from "./yougileAccount";

const KEY = "abcdefghijklmnopqrstuvwxyz0123456789";

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

function http(status: number): YougileHttp {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  }));
}

const unreachable: YougileHttp = vi.fn(async () => {
  throw new Error("ENOTFOUND");
});

function authHost(email?: string, key?: string) {
  return {
    openExternal: vi.fn(async () => true),
    promptEmail: vi.fn(async () => email),
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

  it("reports the stored account once the key still works", async () => {
    const status = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, accountLabel: "a@b.ru" })),
      http: http(200),
      environment: noMachineToken,
    });
    expect(status.state).toBe("connected");
    expect(status.authenticated).toBe(true);
    expect(status.accountLabel).toBe("a@b.ru");
    expect(status.actions).toEqual(["logout"]);
  });

  it("does not keep showing an account whose key the API rejects", async () => {
    const status = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, accountLabel: "a@b.ru" })),
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
      store: store(JSON.stringify({ key: KEY, accountLabel: "a@b.ru" })),
      http: unreachable,
      environment: noMachineToken,
    });
    expect(offline.state).toBe("unknown");
    expect(offline.accountLabel).toBe("a@b.ru");

    const serverError = await yougileAccountStatus({
      store: store(JSON.stringify({ key: KEY, accountLabel: "a@b.ru" })),
      http: http(503),
      environment: noMachineToken,
    });
    expect(serverError.state).toBe("unknown");
    expect(serverError.accountLabel).toBe("a@b.ru");
  });

  it("opens the browser and stores the key only after the API accepts it", async () => {
    const secrets = store();
    const host = authHost("owner@company.ru", KEY);
    const probe = http(200);

    const result = await runYougileAuthAction("login", {
      host,
      store: secrets,
      http: probe,
    });

    expect(host.openExternal).toHaveBeenCalledWith(YOUGILE_LOGIN_URL);
    expect(probe).toHaveBeenCalledWith(
      `${YOUGILE_API_BASE}/users?limit=1`,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    );
    expect(JSON.parse(secrets.values.get(YOUGILE_SECRET_KEY) ?? "{}")).toEqual({
      key: KEY,
      accountLabel: "owner@company.ru",
      source: "plugin",
    });
    expect(result.message).toContain("owner@company.ru");
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
    expect(fromFile.accountLabel).toBeUndefined();

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
  });

  it("prefers the key signed in here over the machine's", async () => {
    const status = await yougileAccountStatus({
      store: store(
        JSON.stringify({
          key: "plugin-owned-key-0123456789",
          accountLabel: "owner@company.ru",
        }),
      ),
      http: http(200),
      environment: {
        env: { YOUGILE_TOKEN: KEY },
        homedir: () => "C:\\nobody",
        readFile: () => undefined,
      },
    });
    expect(status.accountLabel).toBe("owner@company.ru");
    expect(status.actions).toEqual(["logout"]);
  });

  it("saves nothing when the key is refused, the flow is cancelled, or the e-mail is junk", async () => {
    const refused = store();
    await runYougileAuthAction("login", {
      host: authHost("owner@company.ru", KEY),
      store: refused,
      http: http(401),
    });
    expect(refused.store).not.toHaveBeenCalled();

    const cancelled = store();
    const cancelledHost = authHost("owner@company.ru", undefined);
    await runYougileAuthAction("login", {
      host: cancelledHost,
      store: cancelled,
      http: http(200),
    });
    expect(cancelled.store).not.toHaveBeenCalled();

    const badEmail = store();
    const badEmailHost = authHost("not-an-email", KEY);
    await runYougileAuthAction("login", {
      host: badEmailHost,
      store: badEmail,
      http: http(200),
    });
    expect(badEmail.store).not.toHaveBeenCalled();
    // The key is never even asked for once the identity is unusable.
    expect(badEmailHost.promptSecret).not.toHaveBeenCalled();
  });

  it("forgets the key on sign-out", async () => {
    const secrets = store(JSON.stringify({ key: KEY, accountLabel: "a@b.ru" }));
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
