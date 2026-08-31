import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { EventEmitter } from "events";
import { spawn as spawnChild } from "child_process";
import { PassThrough } from "stream";

import {
  accountLabelFromAuthMetadata,
  nativeCliCandidates,
  probeSpec,
  notInstalledVendorStatus,
  notSupportedVendorStatus,
  classifyVendorAuthOutput,
  isMissingCliError,
  kimiDisplayIdentityFromUserInfo,
  localKimiCredentials,
  localKimiServerIdentity,
  localKimiServerEmail,
  managedKimiProfileIdentity,
  kimiCredentialFingerprint,
  clearBrokerVendorAccountCache,
  terminateWindowsProcessTree,
  probeVendorExecutable,
  resolveKimiAccountIdentity,
  storedCodexAccountLabel,
  vendorAuthTerminalCommand,
} from "./bridgeVendorAuth";

describe("Cukii vendor CLI accounts", () => {
  function jwt(payload: Record<string, unknown>): string {
    return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  }

  it("classifies real CLI status shapes without a decorative local flag", () => {
    expect(
      classifyVendorAuthOutput(
        "claude",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "owner@example.com",
        }),
      ),
    ).toMatchObject({
      state: "connected",
      accountLabel: "owner@example.com",
      actions: ["logout"],
    });
    expect(
      classifyVendorAuthOutput("codex", "Logged in using ChatGPT"),
    ).toMatchObject({
      state: "connected",
      authenticated: true,
      accountLabel: "Connected",
    });
    expect(
      classifyVendorAuthOutput("grok", "You are logged in with grok.com."),
    ).toMatchObject({
      state: "connected",
      authenticated: true,
      accountLabel: "Connected",
    });
    expect(
      classifyVendorAuthOutput(
        "cursor",
        JSON.stringify({
          isAuthenticated: true,
          userInfo: { email: "owner@example.com" },
        }),
      ),
    ).toMatchObject({
      state: "connected",
      accountLabel: "owner@example.com",
    });
    const kimiWithoutIdentity = classifyVendorAuthOutput(
      "kimi",
      "managed:kimi-code source=oauth",
    );
    expect(kimiWithoutIdentity).toMatchObject({
      state: "connected",
      authenticated: true,
      actions: ["logout"],
    });
    expect(kimiWithoutIdentity).not.toHaveProperty("accountLabel");
    expect(
      classifyVendorAuthOutput(
        "qwen",
        '{"credentialPresent":true,"accountLabel":"owner@alibaba.example"}',
        "owner@alibaba.example",
      ),
    ).toMatchObject({
      state: "connected",
      authenticated: true,
      accountLabel: "owner@alibaba.example",
      actions: ["logout"],
    });
  });

  it("uses local native auth metadata for a safe, stable account label", () => {
    expect(
      accountLabelFromAuthMetadata("grok", {
        "https://auth.x.ai::profile": {
          email: "owner@example.com",
        },
      }),
    ).toBe("owner@example.com");
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          {
            access_token:
              "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUuY29tIn0.signature",
          },
        ],
      }),
    ).toBe("owner@example.com");
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          { access_token: jwt({ preferred_username: "moonshot" }) },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("qwen", {
        email: "owner@alibaba.example",
        credentialPresent: true,
      }),
    ).toBe("owner@alibaba.example");
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [{ access_token: "not-a-jwt" }],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          {
            access_token:
              "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im1hbGZvcm1lZEBleGFtcGxlLnRlc3QifQ.",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          { access_token: jwt({ email: "expired@example.test", exp: 0 }) },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          {
            access_token: jwt({
              email: "future@example.test",
              nbf: 4_102_444_800,
            }),
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("codex", {
        tokens: { id_token: jwt({ email: "codex@example.test" }) },
      }),
    ).toBe("codex@example.test");
  });

  it("never exposes technical Codex claims when a native status proves login", () => {
    const opaqueId = "26c36ff2-8f7f-4e6f-9b51-0ab3f003bd4b";
    const token = jwt({
      account_id: opaqueId,
      sub: opaqueId,
      user_id: opaqueId,
    });
    const guidOnly = accountLabelFromAuthMetadata("codex", {
      tokens: { id_token: token, account_id: opaqueId },
    });

    expect(guidOnly).toBeUndefined();
    const status = classifyVendorAuthOutput(
      "codex",
      "Logged in using ChatGPT",
      guidOnly ?? opaqueId,
    );
    expect(status).toMatchObject({
      state: "connected",
      authenticated: true,
      accountLabel: "Connected",
    });
    expect(JSON.stringify(status)).not.toContain(opaqueId);
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it("keeps malformed or expired Codex JWTs out of identity while native status remains authoritative", () => {
    const malformed = "not-a-jwt";
    const expired = jwt({ email: "expired@example.test", exp: 0 });
    for (const idToken of [malformed, expired]) {
      const identity = accountLabelFromAuthMetadata("codex", {
        tokens: { id_token: idToken },
      });
      const connected = classifyVendorAuthOutput(
        "codex",
        "Logged in using ChatGPT",
        identity,
      );
      const signedOut = classifyVendorAuthOutput(
        "codex",
        "not logged in",
        identity,
      );
      expect(connected).toMatchObject({
        state: "connected",
        authenticated: true,
        accountLabel: "Connected",
      });
      expect(signedOut).toMatchObject({
        state: "disconnected",
        accountLabel: "Not logged in",
      });
      expect(JSON.stringify({ connected, signedOut })).not.toContain(idToken);
    }
  });

  it("shows a structurally valid expired Codex email only after native status confirms login", () => {
    const expired = jwt({ email: "owner@example.test", exp: 0 });
    const metadata = { tokens: { id_token: expired } };

    // General metadata extraction remains freshness-strict, so a stale token
    // cannot authenticate or label an unverified route by itself.
    expect(accountLabelFromAuthMetadata("codex", metadata)).toBeUndefined();
    expect(storedCodexAccountLabel(metadata)).toBe("owner@example.test");
    expect(
      classifyVendorAuthOutput(
        "codex",
        "Logged in using ChatGPT",
        storedCodexAccountLabel(metadata),
      ),
    ).toMatchObject({
      state: "connected",
      authenticated: true,
      accountLabel: "owner@example.test",
    });
    const signedOut = classifyVendorAuthOutput(
      "codex",
      "not logged in",
      storedCodexAccountLabel(metadata),
    );
    expect(signedOut).toMatchObject({
      state: "disconnected",
      authenticated: false,
      accountLabel: "Not logged in",
    });
    expect(JSON.stringify(signedOut)).not.toContain("owner@example.test");
    expect(
      storedCodexAccountLabel({
        tokens: {
          id_token: jwt({ email: "future@example.test", nbf: 4_102_444_800 }),
        },
      }),
    ).toBeUndefined();
    expect(
      storedCodexAccountLabel({
        tokens: { id_token: jwt({ email: "owner@example.test\u000b" }) },
      }),
    ).toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain(
      storedCodexAccountLabel(metadata)!,
    );
  });

  it("skips malformed Kimi credential files and prefers the newest valid one", () => {
    const directory = "C:\\Users\\owner\\.kimi-code\\credentials";
    const credentials = localKimiCredentials(directory, {
      readdirSync: () => ["broken.json", "current.json"],
      statSync: (file) => ({
        isFile: () => true,
        size: 100,
        mtimeMs: file.endsWith("current.json") ? 200 : 100,
      }),
      readFileSync: (file) => {
        if (String(file).endsWith("broken.json")) return "{";
        return JSON.stringify({
          access_token: jwt({ email: "current@example.test" }),
        });
      },
    });

    expect(accountLabelFromAuthMetadata("kimi", { credentials })).toBe(
      "current@example.test",
    );
    expect(JSON.stringify(credentials)).not.toContain("eyJhbGciOiJub25lIn0");
  });

  it("never sends a registry bearer to a hostile loopback service", async () => {
    const bearer = "test-bearer-do-not-display";
    let requested: { endpoint: URL; bearerToken: string } | undefined;
    const email = await localKimiServerEmail({
      instancesDirectory: "C:\\Users\\owner\\.kimi-code\\server\\instances",
      tokenFile: "C:\\Users\\owner\\.kimi-code\\server.token",
      fileSystem: {
        readdirSync: () => ["instance.json"],
        statSync: () => ({ isFile: () => true, size: 100 }),
        readFileSync: (file) =>
          file.endsWith(".token")
            ? bearer
            : JSON.stringify({ host: "127.0.0.1", port: 58627 }),
      },
      request: async (endpoint, bearerToken) => {
        requested = { endpoint, bearerToken };
        return undefined;
      },
    });

    expect(email).toBeUndefined();
    expect(requested).toBeUndefined();
    expect(JSON.stringify({ email, requested })).not.toContain(bearer);
  });

  it("bounds Kimi loopback failures and does not launch a server", async () => {
    let requested = false;
    const noInstance = await localKimiServerEmail({
      instancesDirectory: "C:\\Users\\owner\\.kimi-code\\server\\instances",
      tokenFile: "C:\\Users\\owner\\.kimi-code\\server.token",
      fileSystem: {
        readdirSync: () => [],
        statSync: () => ({ isFile: () => true, size: 20 }),
        readFileSync: () => "unused",
      },
      request: async () => {
        requested = true;
        return undefined;
      },
    });
    expect(noInstance).toBeUndefined();
    expect(requested).toBe(false);

    const remoteInstance = await localKimiServerEmail({
      instancesDirectory: "C:\\Users\\owner\\.kimi-code\\server\\instances",
      tokenFile: "C:\\Users\\owner\\.kimi-code\\server.token",
      fileSystem: {
        readdirSync: () => ["remote.json"],
        statSync: () => ({ isFile: () => true, size: 20 }),
        readFileSync: (file) =>
          file.endsWith(".token")
            ? "test-bearer-do-not-display"
            : JSON.stringify({ url: "http://example.test:58627" }),
      },
      request: async () => {
        requested = true;
        return undefined;
      },
    });
    expect(remoteInstance).toBeUndefined();
    expect(requested).toBe(false);

    const server = http.createServer(() => undefined);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      await expect(
        localKimiServerEmail({
          instancesDirectory: "C:\\Users\\owner\\.kimi-code\\server\\instances",
          tokenFile: "C:\\Users\\owner\\.kimi-code\\server.token",
          timeoutMs: 25,
          fileSystem: {
            readdirSync: () => ["instance.json"],
            statSync: () => ({ isFile: () => true, size: 20 }),
            readFileSync: (file) =>
              file.endsWith(".token")
                ? "test-bearer-do-not-display"
                : JSON.stringify({ host: "127.0.0.1", port }),
          },
        }),
      ).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses a bounded private Kimi startup banner only for its exact loopback URL", async () => {
    const bearer = "test-bearer-do-not-display";
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout,
      stderr,
    }) as unknown as import("child_process").ChildProcess;
    let stopped = 0;
    let requested: { endpoint: URL; bearerToken: string } | undefined;
    const email = await localKimiServerEmail({
      executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
      instancesDirectory: "C:\\test\\kimi\\instances",
      fileSystem: {
        readdirSync: () => [],
        statSync: () => ({ isFile: () => false, size: 0 }),
        readFileSync: () => "",
      },
      launchTimeoutMs: 100,
      reservePort: async () => 58627,
      launch: () => {
        setImmediate(() =>
          stderr.end(`Kimi server: http://127.0.0.1:58627/#token=${bearer}\n`),
        );
        return child;
      },
      request: async (endpoint, actualBearer) => {
        requested = { endpoint, bearerToken: actualBearer };
        return {
          data: { kind: "ok", userInfo: { email: "ephemeral@example.test" } },
        };
      },
      stopEphemeral: async (actualChild, endpoint, actualBearer) => {
        expect(actualChild).toBe(child);
        expect(endpoint?.toString()).toBe("http://127.0.0.1:58627/");
        expect(actualBearer).toBe(bearer);
        stopped += 1;
      },
    });

    expect(email).toBe("ephemeral@example.test");
    expect(requested?.endpoint.toString()).toBe("http://127.0.0.1:58627/");
    expect(requested?.bearerToken).toBe(bearer);
    expect(stopped).toBe(1);
    expect(
      JSON.stringify({ email, requested: { endpoint: requested?.endpoint } }),
    ).not.toContain(bearer);
  });

  it("survives the Windows launcher exit and accepts Kimi's own port-0 binding", async () => {
    const bearer = "dynamic-port-bearer-do-not-display";
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout,
      stderr,
    }) as unknown as import("child_process").ChildProcess;
    let requests = 0;
    const identity = await localKimiServerIdentity({
      executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
      launchTimeoutMs: 100,
      launch: (_executable, port) => {
        expect(port).toBe(0);
        setImmediate(() => {
          child.emit("exit", 0, null);
          stderr.end(`Kimi server: http://127.0.0.1:61337/#token=${bearer}\n`);
        });
        return child;
      },
      request: async (endpoint, actualBearer) => {
        requests += 1;
        expect(endpoint.toString()).toBe("http://127.0.0.1:61337/");
        expect(actualBearer).toBe(bearer);
        return {
          data: { kind: "ok", userInfo: { nickname: "Moonshot owner" } },
        };
      },
      stopEphemeral: async () => undefined,
    });

    expect(identity).toBe("Moonshot owner");
    expect(requests).toBe(1);
    expect(JSON.stringify({ identity, requests })).not.toContain(bearer);
  });

  it("rejects hostile, oversized, timed-out, and aborted Kimi banners and always cleans up its child", async () => {
    const scenarios = [
      "Kimi web: http://example.test:58627/?token=do-not-use\\n",
      `x`.repeat(8 * 1024 + 1),
      undefined,
    ];
    for (const banner of scenarios) {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 4242,
        killed: false,
        stdout,
        stderr,
      }) as unknown as import("child_process").ChildProcess;
      let requests = 0;
      let stops = 0;
      await expect(
        localKimiServerEmail({
          executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
          instancesDirectory: "C:\\test\\kimi\\instances",
          fileSystem: {
            readdirSync: () => [],
            statSync: () => ({ isFile: () => false, size: 0 }),
            readFileSync: () => "",
          },
          launchTimeoutMs: 25,
          reservePort: async () => 58627,
          launch: () => {
            if (banner !== undefined) {
              setImmediate(() => stdout.end(banner));
            }
            return child;
          },
          request: async () => {
            requests += 1;
            return undefined;
          },
          stopEphemeral: async () => {
            stops += 1;
          },
        }),
      ).resolves.toBeUndefined();
      expect(requests).toBe(0);
      expect(stops).toBe(1);
    }

    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout,
      stderr,
    }) as unknown as import("child_process").ChildProcess;
    let stopped = 0;
    await expect(
      localKimiServerEmail({
        executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
        instancesDirectory: "C:\\test\\kimi\\instances",
        fileSystem: {
          readdirSync: () => [],
          statSync: () => ({ isFile: () => false, size: 0 }),
          readFileSync: () => "",
        },
        launchTimeoutMs: 100,
        reservePort: async () => 58627,
        signal: controller.signal,
        launch: () => {
          controller.abort();
          return child;
        },
        stopEphemeral: async () => {
          stopped += 1;
        },
      }),
    ).resolves.toBeUndefined();
    expect(stopped).toBe(1);
  });

  it("caches a Kimi email obtained from the ephemeral banner without respawning", async () => {
    let launches = 0;
    const options = {
      executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
      instancesDirectory: "C:\\test\\kimi\\instances",
      fileSystem: {
        readdirSync: () => [],
        statSync: () => ({ isFile: () => false, size: 0 }),
        readFileSync: () => "",
      },
      cacheKey: "test-ephemeral-banner-fingerprint-1",
      launchTimeoutMs: 100,
      reservePort: async () => 58627,
      launch: () => {
        launches += 1;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          pid: 4242,
          killed: false,
          stdout,
          stderr,
        }) as unknown as import("child_process").ChildProcess;
        setImmediate(() =>
          stdout.end(
            "http://127.0.0.1:58627/#token=test-bearer-do-not-display\n",
          ),
        );
        return child;
      },
      request: async () => ({
        data: { kind: "ok", userInfo: { email: "cached@example.test" } },
      }),
      stopEphemeral: async () => undefined,
    };
    await expect(localKimiServerEmail(options)).resolves.toBe(
      "cached@example.test",
    );
    await expect(localKimiServerEmail(options)).resolves.toBe(
      "cached@example.test",
    );
    expect(launches).toBe(1);
  });

  it("refreshes a cached Kimi identity after its bounded TTL even when credentials are unchanged", async () => {
    let launches = 0;
    let now = 1_000;
    const options = {
      executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
      cacheKey: "test-ephemeral-banner-fingerprint-ttl",
      cacheTtlMs: 50,
      now: () => now,
      launchTimeoutMs: 100,
      reservePort: async () => 58627,
      launch: () => {
        launches += 1;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          pid: 4242,
          killed: false,
          stdout,
          stderr,
        }) as unknown as import("child_process").ChildProcess;
        setImmediate(() =>
          stdout.end(
            "http://127.0.0.1:58627/#token=test-bearer-do-not-display\n",
          ),
        );
        return child;
      },
      request: async () => ({
        data: {
          kind: "ok",
          userInfo: { email: `cached-${launches}@example.test` },
        },
      }),
      stopEphemeral: async () => undefined,
    };
    await expect(localKimiServerEmail(options)).resolves.toBe(
      "cached-1@example.test",
    );
    now += 49;
    await expect(localKimiServerEmail(options)).resolves.toBe(
      "cached-1@example.test",
    );
    now += 1;
    await expect(localKimiServerEmail(options)).resolves.toBe(
      "cached-2@example.test",
    );
    expect(launches).toBe(2);
  });

  it("invalidates the Kimi identity cache for login and logout refreshes", async () => {
    let launches = 0;
    const options = {
      executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
      cacheKey: "test-ephemeral-banner-fingerprint-action",
      launchTimeoutMs: 100,
      reservePort: async () => 58627,
      launch: () => {
        launches += 1;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), {
          pid: 4242,
          killed: false,
          stdout,
          stderr,
        }) as unknown as import("child_process").ChildProcess;
        setImmediate(() =>
          stdout.end(
            "http://127.0.0.1:58627/#token=test-bearer-do-not-display\n",
          ),
        );
        return child;
      },
      request: async () => ({
        data: {
          kind: "ok",
          userInfo: { email: `account-${launches}@example.test` },
        },
      }),
      stopEphemeral: async () => undefined,
    };
    await expect(localKimiServerEmail(options)).resolves.toBe(
      "account-1@example.test",
    );
    clearBrokerVendorAccountCache();
    await expect(localKimiServerEmail(options)).resolves.toBe(
      "account-2@example.test",
    );
    expect(launches).toBe(2);
  });

  it.runIf(process.platform === "win32")(
    "kills a reparented Kimi server when its launcher exits during cleanup",
    async () => {
      const directory = fs.mkdtempSync(
        "D:\\Scratch\\cukii-kimi-orphan-negative-control-",
      );
      const pidFile = path.join(directory, "worker.pid");
      let workerPid: number | undefined;
      try {
        await expect(
          localKimiServerIdentity({
            executable: process.execPath,
            launchTimeoutMs: 80,
            launch: () =>
              spawnChild(
                process.execPath,
                [
                  "-e",
                  [
                    "const {spawn}=require('child_process')",
                    `const worker=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})`,
                    `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(worker.pid))`,
                    "worker.unref()",
                    "setTimeout(()=>process.exit(0),120)",
                  ].join(";"),
                ],
                { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
              ),
          }),
        ).resolves.toBeUndefined();
        workerPid = Number(fs.readFileSync(pidFile, "utf8"));
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(() => process.kill(workerPid!, 0)).toThrow();
      } finally {
        if (workerPid) {
          try {
            process.kill(workerPid, "SIGKILL");
          } catch {
            // Expected once production cleanup owns the descendant.
          }
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("changes the Kimi cache fingerprint when credentials switch at identical metadata", () => {
    const directory = fs.mkdtempSync("D:\\Scratch\\cukii-kimi-fingerprint-");
    const credentialsDirectory = path.join(
      directory,
      ".kimi-code",
      "credentials",
    );
    const credential = path.join(credentialsDirectory, "default.json");
    fs.mkdirSync(credentialsDirectory, { recursive: true });
    const first = JSON.stringify({
      access_token: jwt({ email: "first@example.test" }),
    });
    const second = JSON.stringify({
      access_token: jwt({ email: "other@example.test" }),
    });
    expect(first.length).toBe(second.length);
    const mtime = new Date("2026-08-31T00:00:00.000Z");
    try {
      fs.writeFileSync(credential, first, "utf8");
      fs.utimesSync(credential, mtime, mtime);
      const firstFingerprint = kimiCredentialFingerprint(directory);
      fs.writeFileSync(credential, second, "utf8");
      fs.utimesSync(credential, mtime, mtime);
      const secondFingerprint = kimiCredentialFingerprint(directory);
      expect(secondFingerprint).not.toBe(firstFingerprint);
      expect(secondFingerprint).not.toContain("other@example.test");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not join startup banners across stdout and stderr or exceed either stream bound", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout,
      stderr,
    }) as unknown as import("child_process").ChildProcess;
    const bearer = "split-banner-bearer";
    let requests = 0;
    let stops = 0;
    await expect(
      localKimiServerEmail({
        executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
        launchTimeoutMs: 25,
        reservePort: async () => 58627,
        launch: () => {
          setImmediate(() => {
            stdout.end(`http://127.0.0.1:58627/#token=${bearer.slice(0, 8)}`);
            stderr.end(bearer.slice(8));
          });
          return child;
        },
        request: async () => {
          requests += 1;
          return undefined;
        },
        stopEphemeral: async () => {
          stops += 1;
        },
      }),
    ).resolves.toBeUndefined();
    expect(requests).toBe(0);
    expect(stops).toBe(1);
    expect(JSON.stringify({ requests, stops })).not.toContain(bearer);
  });

  it("cleans up after child exit even when both startup streams reach their bound", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout,
      stderr,
    }) as unknown as import("child_process").ChildProcess;
    let requests = 0;
    let stops = 0;
    await expect(
      localKimiServerEmail({
        executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
        launchTimeoutMs: 100,
        reservePort: async () => 58627,
        launch: () => {
          setImmediate(() => {
            stdout.write("x".repeat(8 * 1024));
            stderr.write("y".repeat(8 * 1024));
            child.emit("exit", 1);
          });
          return child;
        },
        request: async () => {
          requests += 1;
          return undefined;
        },
        stopEphemeral: async () => {
          stops += 1;
        },
      }),
    ).resolves.toBeUndefined();
    expect(requests).toBe(0);
    expect(stops).toBe(1);
  });

  it("falls back to a descendant-aware Windows cleanup when taskkill /T fails", async () => {
    const calls: Array<{ program: string; args: string[] }> = [];
    await expect(
      terminateWindowsProcessTree(4242, async (program, args) => {
        calls.push({ program, args });
        if (program === "taskkill") throw new Error("taskkill unavailable");
      }),
    ).resolves.toBeUndefined();
    expect(calls[0]).toEqual({
      program: "taskkill",
      args: ["/pid", "4242", "/T", "/F"],
    });
    expect(calls[1]?.program).toMatch(/powershell\.exe$/i);
    expect(calls[1]?.args).toContain("4242");
    expect(calls[1]?.args.join(" ")).toContain("ParentProcessId");
    expect(calls[1]?.args.join(" ")).toContain("Stop-Process");
  });

  it("bounds the private userinfo response at 64 KiB", async () => {
    const bearer = "large-response-bearer";
    const server = http.createServer((request, response) => {
      expect(request.url).toBe("/api/v1/oauth/userinfo");
      expect(request.headers.authorization).toBe(`Bearer ${bearer}`);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(64 * 1024 + 1));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout,
      stderr,
    }) as unknown as import("child_process").ChildProcess;
    let stops = 0;
    try {
      await expect(
        localKimiServerEmail({
          executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
          launchTimeoutMs: 100,
          reservePort: async () => port,
          launch: () => {
            setImmediate(() =>
              stdout.end(`http://127.0.0.1:${port}/#token=${bearer}\n`),
            );
            return child;
          },
          stopEphemeral: async () => {
            stops += 1;
          },
        }),
      ).resolves.toBeUndefined();
      expect(stops).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("swallows cleanup errors that contain an ephemeral bearer", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      killed: false,
      stdout,
      stderr,
    }) as unknown as import("child_process").ChildProcess;
    const bearer = "cleanup-bearer-do-not-display";
    await expect(
      localKimiServerEmail({
        executable: "C:\\Users\\owner\\.kimi-code\\bin\\kimi.exe",
        launchTimeoutMs: 100,
        reservePort: async () => 58627,
        launch: () => {
          setImmediate(() =>
            stdout.end(`http://127.0.0.1:58627/#token=${bearer}\n`),
          );
          return child;
        },
        request: async () => ({
          data: { kind: "ok", userInfo: { email: "owner@example.test" } },
        }),
        stopEphemeral: async () => {
          throw new Error(`cleanup failed: ${bearer}`);
        },
      }),
    ).resolves.toBe("owner@example.test");
  });

  it("keeps connected vendor labels distinguishable by exact email", () => {
    const labels = [
      classifyVendorAuthOutput(
        "claude",
        '{"loggedIn":true,"email":"personal@example.test"}',
      ),
      classifyVendorAuthOutput(
        "codex",
        "Logged in using ChatGPT",
        accountLabelFromAuthMetadata("codex", {
          tokens: { id_token: jwt({ email: "shared@example.test" }) },
        }),
      ),
      classifyVendorAuthOutput(
        "grok",
        "You are logged in with grok.com as xai@example.test",
      ),
      classifyVendorAuthOutput(
        "cursor",
        '{"isAuthenticated":true,"userInfo":{"email":"cursor@example.test"}}',
      ),
      classifyVendorAuthOutput(
        "kimi",
        "managed:kimi-code source=oauth account=moonshot@example.test",
      ),
    ];
    expect(labels.every((status) => status.state === "connected")).toBe(true);
    expect(new Set(labels.map((status) => status.accountLabel)).size).toBe(
      labels.length,
    );
    expect(
      classifyVendorAuthOutput("qwen", '{"credentialPresent":true}'),
    ).toMatchObject({
      state: "connected",
      accountLabel: "Connected",
      actions: ["logout"],
    });
    expect(
      classifyVendorAuthOutput(
        "qwen",
        '{"security":{"auth":{"selectedType":"qwen-oauth"}}}',
      ),
    ).toMatchObject({
      state: "disconnected",
      accountLabel: "Not logged in",
      actions: ["login"],
    });
  });

  it("uses Kimi auth claims only for an exact email", () => {
    const technicalId = "8e780a44-7d30-4a09-b6c4-e779dfd0c5f7";
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          { access_token: jwt({ user_id: technicalId, sub: technicalId }) },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [{ id_token: jwt({ preferred_username: "moonshot" }) }],
      }),
    ).toBeUndefined();
    const status = classifyVendorAuthOutput(
      "kimi",
      "managed:kimi-code source=oauth",
    );
    expect(status).toMatchObject({
      state: "connected",
      authenticated: true,
    });
    expect(status).not.toHaveProperty("accountLabel");
    expect(JSON.stringify(status)).not.toContain(technicalId);
  });

  it("derives a stable automatic Moonshot identity from the official profile", () => {
    expect(
      kimiDisplayIdentityFromUserInfo({
        email: "moonshot@example.test",
        nickname: "ignored when email is available",
        globalId: "account-000001",
      }),
    ).toBe("moonshot@example.test");
    expect(
      kimiDisplayIdentityFromUserInfo({
        nickname: "Workspace owner",
        globalId: "account-123456",
      }),
    ).toBe("Workspace owner");
    expect(
      kimiDisplayIdentityFromUserInfo({ globalId: "account-abcdef" }),
    ).toBeUndefined();
    expect(
      kimiDisplayIdentityFromUserInfo({
        nickname: "Connected",
        globalId: "too-short",
      }),
    ).toBeUndefined();
    expect(
      kimiDisplayIdentityFromUserInfo({
        nickname: "unsafe\u0000name",
        globalId: "short",
      }),
    ).toBeUndefined();
  });

  it("uses the official Moonshot profile without an email seed", async () => {
    const bearer = "test-bearer-do-not-display";
    const identity = await managedKimiProfileIdentity({
      userHome: "C:\\Users\\owner",
      fileSystem: {
        readdirSync: () => ["active.json"],
        statSync: () => ({
          isFile: () => true,
          size: 200,
          mtimeMs: 100,
        }),
        readFileSync: () => JSON.stringify({ access_token: bearer }),
      },
      request: async (actualBearer) => {
        expect(actualBearer).toBe(bearer);
        return {
          status: 200,
          payload: {
            nickname: "Moonshot owner",
            global_id: "official-account-654321",
          },
        };
      },
    });

    expect(identity).toBe("Moonshot owner");
    expect(JSON.stringify({ identity })).not.toContain(bearer);
  });

  it("falls back to the native Kimi server when the stored access token is stale", async () => {
    const calls: string[] = [];
    await expect(
      resolveKimiAccountIdentity(
        async () => {
          calls.push("expired-profile");
          return undefined;
        },
        async () => {
          calls.push("native-refresh-session");
          return "Moonshot owner";
        },
      ),
    ).resolves.toBe("Moonshot owner");
    expect(calls).toEqual(["expired-profile", "native-refresh-session"]);
  });

  it("uses identities from exact Grok and Kimi CLI status formats", () => {
    expect(
      classifyVendorAuthOutput(
        "grok",
        "You are logged in with grok.com as stdout-leak@example.test",
      ).accountLabel,
    ).toBe("stdout-leak@example.test");
    expect(
      classifyVendorAuthOutput(
        "kimi",
        "managed:kimi-code source=oauth account=stdout-leak@example.test",
      ).accountLabel,
    ).toBe("stdout-leak@example.test");
    expect(
      classifyVendorAuthOutput(
        "kimi",
        "managed:kimi-code source=oauth account=@moonshot",
      ).accountLabel,
    ).toBeUndefined();
  });

  it("allows terminal CRLF framing for exact Grok and Kimi status lines", () => {
    expect(
      classifyVendorAuthOutput(
        "grok",
        "You are logged in with grok.com as owner@example.test\r\n",
      ).accountLabel,
    ).toBe("owner@example.test");
    expect(
      classifyVendorAuthOutput(
        "kimi",
        "managed:kimi-code source=oauth account=owner@example.test\r\n",
      ).accountLabel,
    ).toBe("owner@example.test");
  });

  it("rejects vertical-tab framing before strict Grok and Kimi identity checks", () => {
    const unavailable = "Connected";
    const kimiUnavailable = undefined;
    expect(
      classifyVendorAuthOutput(
        "grok",
        "\u000BYou are logged in with grok.com as owner@example.test\u000B",
      ).accountLabel,
    ).toBe(unavailable);
    expect(
      classifyVendorAuthOutput(
        "kimi",
        "\u000Bmanaged:kimi-code source=oauth account=owner@example.test\u000B",
      ).accountLabel,
    ).toBe(kimiUnavailable);
  });

  it("accepts only allowlisted JSON identity fields from Grok and Kimi", () => {
    expect(
      classifyVendorAuthOutput(
        "grok",
        JSON.stringify({
          authenticated: true,
          user: { email: "grok-json@example.test" },
        }),
      ).accountLabel,
    ).toBe("grok-json@example.test");
    expect(
      classifyVendorAuthOutput(
        "kimi",
        JSON.stringify({
          source: "oauth",
          account: { email: "kimi-json@example.test" },
        }),
      ).accountLabel,
    ).toBe("kimi-json@example.test");
  });

  it("never derives a native CLI identity from arbitrary or secret-like output", () => {
    const unavailable = "Connected";
    const kimiUnavailable = undefined;
    expect(
      classifyVendorAuthOutput(
        "grok",
        "You are logged in with grok.com as api_key=sk-live-secret@example.test",
      ).accountLabel,
    ).toBe(unavailable);
    expect(
      classifyVendorAuthOutput(
        "kimi",
        "managed:kimi-code source=oauth account=api_key=sk-live-secret@example.test",
      ).accountLabel,
    ).toBe(kimiUnavailable);
    expect(
      classifyVendorAuthOutput(
        "grok",
        "You are logged in with grok.com. Contact arbitrary@example.test",
      ).accountLabel,
    ).toBe(unavailable);
    expect(
      classifyVendorAuthOutput(
        "kimi",
        "managed:kimi-code source=oauth diagnostics=user=arbitrary@example.test",
      ).accountLabel,
    ).toBe(kimiUnavailable);
    expect(
      classifyVendorAuthOutput(
        "grok",
        "You are logged in with grok.com as owner@example.test\naccess_token=secret",
      ).accountLabel,
    ).toBe(unavailable);
    expect(
      classifyVendorAuthOutput(
        "kimi",
        JSON.stringify({
          source: "oauth",
          account: { email: "token-owner@example.test" },
        }),
      ).accountLabel,
    ).toBe(kimiUnavailable);
  });

  it("discovers Cursor from native Windows product locations before PATH", () => {
    const candidates = nativeCliCandidates(
      "cursor",
      "C:\\Users\\owner",
      "win32",
      { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" },
    );
    expect(candidates.slice(0, 2)).toEqual([
      "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.cmd",
      "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.ps1",
    ]);
    expect(
      nativeCliCandidates("cursor", "C:\\Users\\owner", "win32", {}),
    ).toContain(
      "C:\\Users\\owner\\AppData\\Local\\Programs\\Cursor\\resources\\app\\bin\\agent.exe",
    );
    expect(
      nativeCliCandidates("cursor", "C:\\Users\\owner", "win32", {}),
    ).toContain("C:\\Program Files\\Cursor\\resources\\app\\bin\\agent.exe");
    expect(
      nativeCliCandidates("cursor", "C:\\Users\\owner", "win32", {}),
    ).not.toContain("agent");
    expect(
      probeSpec(
        "cursor",
        "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.ps1",
      ),
    ).toMatchObject({
      program: expect.stringMatching(/powershell\.exe$/i),
      args: expect.arrayContaining([
        "-File",
        "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.ps1",
        "status",
      ]),
    });
  });

  it("uses the required disconnected, unavailable, and connected fallback copy", () => {
    expect(notInstalledVendorStatus("cursor")).toMatchObject({
      installed: false,
      authenticated: false,
      state: "unavailable",
      accountLabel: "Not installed",
      actions: ["install"],
    });
    expect(notSupportedVendorStatus()).toMatchObject({
      id: "deepseek",
      installed: false,
      authenticated: false,
      state: "postponed",
      accountLabel: "Coming soon",
      actions: [],
    });
    for (const vendor of [
      "claude",
      "codex",
      "grok",
      "cursor",
      "kimi",
      "qwen",
    ] as const) {
      expect(classifyVendorAuthOutput(vendor, "not logged in")).toMatchObject({
        state: "disconnected",
        authenticated: false,
        accountLabel: "Not logged in",
        actions: ["login"],
      });
    }
    const connectedKimiWithoutIdentity = classifyVendorAuthOutput(
      "kimi",
      "managed:kimi-code source=oauth",
    );
    expect(connectedKimiWithoutIdentity).toMatchObject({
      state: "connected",
      authenticated: true,
      actions: ["logout"],
    });
    expect(connectedKimiWithoutIdentity).not.toHaveProperty("accountLabel");
    const labels = [
      classifyVendorAuthOutput("claude", '{"loggedIn":false}').accountLabel,
      classifyVendorAuthOutput("codex", "not logged in").accountLabel,
      classifyVendorAuthOutput("grok", "not logged in").accountLabel,
      classifyVendorAuthOutput("cursor", "not logged in").accountLabel,
      classifyVendorAuthOutput("kimi", "not logged in").accountLabel,
      classifyVendorAuthOutput("qwen", "not logged in").accountLabel,
    ];
    expect(labels).toEqual(Array(6).fill("Not logged in"));
    expect(
      classifyVendorAuthOutput("codex", "request timed out"),
    ).toMatchObject({
      state: "unknown",
      authenticated: false,
      accountLabel: "Account status unavailable",
    });
  });

  it("uses only supported native login/logout flows", () => {
    expect(vendorAuthTerminalCommand("claude", "logout")?.command).toBe(
      "claude auth logout",
    );
    expect(vendorAuthTerminalCommand("codex", "login")?.command).toBe(
      "codex login --device-auth",
    );
    expect(vendorAuthTerminalCommand("cursor", "login")?.command).toContain(
      "agent login",
    );
    expect(vendorAuthTerminalCommand("kimi", "logout")).toMatchObject({
      command: "kimi",
      followup: "/logout",
    });
    expect(vendorAuthTerminalCommand("qwen", "logout")).toBeUndefined();
    expect(vendorAuthTerminalCommand("qwen", "login")).toBeUndefined();
    expect(vendorAuthTerminalCommand("deepseek", "login")).toBeUndefined();
  });

  it("installs the latest official native CLI package", () => {
    expect(vendorAuthTerminalCommand("claude", "install")?.command).toBe(
      "npm install -g @anthropic-ai/claude-code@latest",
    );
    expect(vendorAuthTerminalCommand("codex", "install")?.command).toBe(
      "npm install -g @openai/codex@latest",
    );
    expect(vendorAuthTerminalCommand("grok", "install")?.command).toBe(
      "npm install -g @xai-official/grok@latest",
    );
    expect(vendorAuthTerminalCommand("kimi", "install")?.command).toBe(
      "npm install -g @moonshot-ai/kimi-code@latest",
    );
    expect(vendorAuthTerminalCommand("qwen", "install")?.command).toBe(
      "npm install -g @qwen-code/qwen-code@latest",
    );
    expect(vendorAuthTerminalCommand("cursor", "install")?.command).toContain(
      "https://cursor.com/install?win32=true",
    );
  });

  it("detects missing executables from native Windows and WSL failures", () => {
    expect(
      isMissingCliError({
        stderr: "'qwen' is not recognized as an internal or external command",
      }),
    ).toBe(true);
    expect(
      isMissingCliError({ stderr: "bash: cursor-agent: command not found" }),
    ).toBe(true);
    expect(isMissingCliError(new Error("authentication expired"))).toBe(false);
  });

  it("runs each native Windows .cmd account probe without shell quoting loss", async () => {
    if (process.platform !== "win32") return;
    const directory = fs.mkdtempSync("D:\\Scratch\\cukii-vendor-auth-stubs-");
    const fixture = (name: string, body: string) => {
      const file = path.join(directory, `${name}.cmd`);
      fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, "utf8");
      return file;
    };

    try {
      const statuses = await Promise.all([
        probeVendorExecutable(
          "claude",
          fixture(
            "claude",
            'echo {"loggedIn":true,"email":"claude@example.test"}',
          ),
        ),
        probeVendorExecutable(
          "codex",
          fixture("codex", "echo Logged in using ChatGPT"),
          { metadata: undefined },
        ),
        probeVendorExecutable(
          "grok",
          fixture(
            "grok",
            "echo You are logged in with grok.com as xai@example.test",
          ),
          { metadata: undefined },
        ),
        probeVendorExecutable(
          "cursor",
          fixture(
            "cursor",
            'echo {"isAuthenticated":true,"userInfo":{"email":"cursor@example.test"}}',
          ),
        ),
        probeVendorExecutable(
          "kimi",
          fixture(
            "kimi",
            "echo managed:kimi-code source=oauth account=kimi@example.test",
          ),
          { metadata: undefined },
        ),
        probeVendorExecutable("qwen", fixture("qwen", "echo 0.22.2"), {
          metadata: {
            credentialPresent: true,
            email: "alibaba@example.test",
          },
        }),
      ]);

      expect(statuses.map((status) => status.state)).toEqual([
        "connected",
        "connected",
        "connected",
        "connected",
        "connected",
        "connected",
      ]);
      expect(statuses[2].accountLabel).toBe("xai@example.test");
      expect(statuses[4].accountLabel).toBe("kimi@example.test");
      expect(statuses[5]).toMatchObject({
        id: "qwen",
        label: "Alibaba",
        accountLabel: "alibaba@example.test",
        actions: ["logout"],
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("isolates native rejection and timeout to their own vendor", async () => {
    if (process.platform !== "win32") return;
    const directory = fs.mkdtempSync(
      "D:\\Scratch\\cukii-vendor-auth-failures-",
    );
    const fixture = (name: string, body: string) => {
      const file = path.join(directory, `${name}.cmd`);
      fs.writeFileSync(file, `@echo off\r\n${body}\r\n`, "utf8");
      return file;
    };

    try {
      const [connected, rejected, timedOut] = await Promise.all([
        probeVendorExecutable(
          "codex",
          fixture("codex", "echo Logged in using ChatGPT"),
          { metadata: undefined },
        ),
        probeVendorExecutable(
          "claude",
          fixture("claude", "echo Not signed in\r\nexit /b 1"),
        ),
        probeVendorExecutable(
          "grok",
          fixture("grok", "ping 127.0.0.1 -n 3 > nul"),
          { timeoutMs: 50 },
        ),
      ]);

      expect(connected).toMatchObject({
        state: "connected",
        authenticated: true,
        accountLabel: "Connected",
      });
      expect(rejected).toMatchObject({
        state: "disconnected",
        accountLabel: "Not logged in",
      });
      expect(timedOut).toMatchObject({
        state: "unknown",
        accountLabel: "Account status unavailable",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never passes a hostile .cmd route to ComSpec", async () => {
    if (process.platform !== "win32") return;
    const directory = fs.mkdtempSync("D:\\Scratch\\cukii-vendor-auth-hostile-");
    const marker = path.join(directory, "executed.txt");
    const route = path.join(directory, "grok%CUKII_UNSAFE_ROUTE%.cmd");
    fs.writeFileSync(
      route,
      `@echo off\r\necho executed>"${marker}"\r\n`,
      "utf8",
    );

    try {
      await expect(probeVendorExecutable("grok", route)).resolves.toMatchObject(
        {
          installed: true,
          state: "unknown",
          accountLabel: "Account status unavailable",
        },
      );
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
