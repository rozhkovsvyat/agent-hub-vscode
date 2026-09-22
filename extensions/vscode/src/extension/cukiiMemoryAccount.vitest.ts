import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProtectedSecretStore } from "./alibabaTokenPlan";
import {
  CUKII_MEMORY_SECRET_KEY,
  CukiiMemoryAccountController,
  CukiiMemoryRelay,
  CukiiMemoryUpstream,
  cukiiMemoryAccountForContext,
  describeDisciplineOutcome,
  normalizeMemoryEndpoint,
  probeCukiiMemory,
} from "./cukiiMemoryAccount";

class MemoryStore implements ProtectedSecretStore {
  readonly values = new Map<string, string>();
  get(key: string) {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function extensionRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-memory-account-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "out", "cukiiMemoryProxy.js"),
    "// fixture\n",
  );
  return root;
}

describe("Cukii Box account", () => {
  it("normalizes only HTTPS or loopback MCP endpoints", () => {
    expect(normalizeMemoryEndpoint("https://box.example.test")).toBe(
      "https://box.example.test/mcp",
    );
    expect(normalizeMemoryEndpoint("http://127.0.0.1:8780/mcp")).toBe(
      "http://127.0.0.1:8780/mcp",
    );
    expect(() =>
      normalizeMemoryEndpoint("http://box.example.test/mcp"),
    ).toThrow(/HTTPS/);
  });

  it("requires both healthz and authenticated MCP initialize", async () => {
    const httpFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return new Response('{"ok":true}');
        expect(init?.headers).toMatchObject({
          authorization: `Bearer ${"t".repeat(32)}`,
        });
        return new Response(
          JSON.stringify({ result: { serverInfo: { name: "cukii-memory" } } }),
        );
      },
    ) as typeof fetch;

    await probeCukiiMemory(
      { endpoint: "https://box.example.test/mcp", token: "t".repeat(32) },
      httpFetch,
    );
    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  it("stores the remote bearer only in SecretStorage and gives vendors a loopback capability", async () => {
    const store = new MemoryStore();
    const descriptors: unknown[] = [];
    const boxToken = "box-secret-" + "x".repeat(40);
    const httpFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return new Response('{"ok":true}');
        const authorization = (
          init?.headers as Record<string, string> | undefined
        )?.authorization;
        expect(authorization).toBe(`Bearer ${boxToken}`);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { serverInfo: { name: "cukii-memory" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    ) as typeof fetch;
    const controller = new CukiiMemoryAccountController(
      store,
      extensionRoot(),
      process.execPath,
      httpFetch,
      {
        ensure: (_vendor, descriptor) => {
          descriptors.push(descriptor);
          return true;
        },
        remove: vi.fn(),
      },
    );

    const result = await controller.runAction("login", {
      promptEndpoint: async () => "https://box.example.test/mcp",
      promptToken: async () => boxToken,
    });
    expect(result.message).toContain("6 vendor CLIs");
    expect(store.values.get(CUKII_MEMORY_SECRET_KEY)).toContain(boxToken);
    expect(JSON.stringify(descriptors)).not.toContain(boxToken);
    const descriptor = descriptors[0] as {
      url: string;
      capability: string;
    };
    expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(descriptor.capability).toHaveLength(43);

    const relayed = await fetch(descriptor.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toMatchObject({
      result: { serverInfo: { name: "cukii-memory" } },
    });
    controller.dispose();
  });

  it("fails closed on the loopback relay capability but leaves chat integration fail-open", async () => {
    const store = new MemoryStore();
    const controller = new CukiiMemoryAccountController(
      store,
      extensionRoot(),
      process.execPath,
      vi.fn() as unknown as typeof fetch,
      { ensure: vi.fn(() => true), remove: vi.fn() },
    );
    expect(await controller.ensureForModel("gpt-5.6-sol")).toBe(false);
    expect(await controller.status()).toMatchObject({
      id: "memory",
      group: "memory",
      state: "disconnected",
      actions: ["login"],
    });
  });

  it("installs the discipline on a session that never presses Log in again", async () => {
    // 🔴 The regression from 2.0.133: memory connected, discipline absent. An
    // owner who connected on the old build never opens Manage Accounts again,
    // so binding this to the button alone would ship it to nobody affected.
    const store = new MemoryStore();
    const boxToken = "d".repeat(43);
    await store.store(
      CUKII_MEMORY_SECRET_KEY,
      JSON.stringify({
        endpoint: "https://box.example.test/mcp",
        token: boxToken,
      }),
    );
    const installed: string[] = [];
    const empty = { written: [], unchanged: [], failed: [] };
    const controller = new CukiiMemoryAccountController(
      store,
      extensionRoot(),
      process.execPath,
      vi.fn() as unknown as typeof fetch,
      { ensure: vi.fn(() => true), remove: vi.fn() },
      {
        fetch: async (endpoint, token) => {
          expect(token).toBe(boxToken);
          return `block-for:${endpoint}`;
        },
        bundled: () => "bundled-block",
        install: (block) => {
          installed.push(block);
          return { ...empty, written: ["CLAUDE.md"] };
        },
        remove: () => empty,
      },
    );

    expect(await controller.ensureForModel("claude-opus-5")).toBe(true);
    expect(installed).toEqual(["block-for:https://box.example.test/mcp"]);

    // Once per activation, not once per CLI spawn.
    await controller.ensureForModel("claude-opus-5");
    expect(installed).toHaveLength(1);
    controller.dispose();
  });

  it("falls back to the shipped copy when the box cannot serve the discipline", async () => {
    // 🔴 The 2.0.134 regression: the box was the only source, so one failed
    // request left the machine with working memory and no contract. A network
    // blink must cost freshness, never the discipline itself.
    const store = new MemoryStore();
    await store.store(
      CUKII_MEMORY_SECRET_KEY,
      JSON.stringify({
        endpoint: "https://box.example.test/mcp",
        token: "e".repeat(43),
      }),
    );
    const empty = { written: [], unchanged: [], failed: [] };
    const installed: string[] = [];
    const log: string[] = [];
    const root = extensionRoot();
    const controller = new CukiiMemoryAccountController(
      store,
      root,
      process.execPath,
      vi.fn() as unknown as typeof fetch,
      { ensure: vi.fn(() => true), remove: vi.fn() },
      {
        fetch: async () => {
          throw new Error("box unreachable");
        },
        bundled: (extensionPath) => `bundled-from:${extensionPath}`,
        install: (block) => {
          installed.push(block);
          return { ...empty, written: ["CLAUDE.md"] };
        },
        remove: () => empty,
      },
      (line) => log.push(line),
    );

    expect(await controller.ensureForModel("claude-opus-5")).toBe(true);
    expect(installed).toEqual([`bundled-from:${root}`]);

    const outcome = controller.lastDisciplineOutcome();
    expect(outcome?.source).toBe("bundled");
    expect(outcome?.boxError).toContain("box unreachable");
    expect(outcome?.written).toEqual(["CLAUDE.md"]);
    // 🔴 The failing request has to name itself in the log. Asserting that the
    // words appear *somewhere* passes on the summary line `record` writes, so
    // deleting the line that reports the request would stay green.
    expect(
      log.filter((line) => line.startsWith("box copy unavailable")),
    ).toEqual(["box copy unavailable: box unreachable"]);
    controller.dispose();
  });

  it("goes back to the box after a run served from the shipped copy", async () => {
    // 🔴 2.0.135 memoized the fallback as a finished job: one failed request
    // pinned the window to the copy inside the VSIX for as long as it stayed
    // open, so editing the rules in the vault stopped reaching the machine.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const store = new MemoryStore();
      await store.store(
        CUKII_MEMORY_SECRET_KEY,
        JSON.stringify({
          endpoint: "https://box.example.test/mcp",
          token: "g".repeat(43),
        }),
      );
      const empty = { written: [], unchanged: [], failed: [] };
      const installed: string[] = [];
      let boxUp = false;
      const controller = new CukiiMemoryAccountController(
        store,
        extensionRoot(),
        process.execPath,
        vi.fn() as unknown as typeof fetch,
        { ensure: vi.fn(() => true), remove: vi.fn() },
        {
          fetch: async () => {
            if (!boxUp) throw new Error("box unreachable");
            return "fresh-box-block";
          },
          bundled: () => "shipped-block",
          install: (block) => {
            installed.push(block);
            return { ...empty, written: ["CLAUDE.md"] };
          },
          remove: () => empty,
        },
      );

      await controller.ensureForModel("claude-opus-5");
      expect(installed).toEqual(["shipped-block"]);

      // Not once per message: inside the window the box is left alone.
      boxUp = true;
      await controller.ensureForModel("claude-opus-5");
      expect(installed).toEqual(["shipped-block"]);

      vi.setSystemTime(Date.now() + 5 * 60_000);
      await controller.ensureForModel("claude-opus-5");
      expect(installed).toEqual(["shipped-block", "fresh-box-block"]);
      expect(controller.lastDisciplineOutcome()?.source).toBe("box");

      // A finished run is remembered, so the box is not polled again.
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await controller.ensureForModel("claude-opus-5");
      expect(installed).toHaveLength(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tries again later when a target could not be written", async () => {
    // A locked or read-only file is reported, not swallowed — and `install`
    // returns that report instead of throwing, which is how a run where
    // nothing landed still counted as done.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const store = new MemoryStore();
      await store.store(
        CUKII_MEMORY_SECRET_KEY,
        JSON.stringify({
          endpoint: "https://box.example.test/mcp",
          token: "h".repeat(43),
        }),
      );
      let attempts = 0;
      const controller = new CukiiMemoryAccountController(
        store,
        extensionRoot(),
        process.execPath,
        vi.fn() as unknown as typeof fetch,
        { ensure: vi.fn(() => true), remove: vi.fn() },
        {
          fetch: async () => "block",
          bundled: () => "shipped-block",
          install: () => {
            attempts += 1;
            return {
              written: [],
              unchanged: [],
              failed: [
                { target: "CLAUDE.md", reason: "locked by another window" },
              ],
            };
          },
          remove: () => ({ written: [], unchanged: [], failed: [] }),
        },
      );

      await controller.ensureForModel("claude-opus-5");
      expect(attempts).toBe(1);
      expect(
        describeDisciplineOutcome(controller.lastDisciplineOutcome()!),
      ).toContain("locked by another window");
      await controller.ensureForModel("claude-opus-5");
      expect(attempts).toBe(1);
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await controller.ensureForModel("claude-opus-5");
      expect(attempts).toBe(2);
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("installs the discipline when the extension activates, not only on a spawn", async () => {
    // 🔴 The trigger itself, asserted where it lives. In 2.0.134 the only
    // trigger sat behind a chat spawn, so a machine that never reached that
    // path came up without the contract and said nothing. With no stored
    // connection the attempt cannot touch a file, so the line it writes is
    // both the proof that activation installs and that the log is wired.
    const log: string[] = [];
    const subscriptions: { dispose(): void }[] = [];
    const context = {
      secrets: new MemoryStore(),
      extensionPath: extensionRoot(),
      subscriptions,
    } as unknown as Parameters<typeof cukiiMemoryAccountForContext>[0];

    cukiiMemoryAccountForContext(context, (line) => log.push(line));
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log).toEqual([
      "discipline NOT installed: Cukii Box is not connected.",
    ]);
    for (const item of subscriptions) item.dispose();
  });

  it("keeps the CLI starting when neither copy can be installed, and retries", async () => {
    const store = new MemoryStore();
    await store.store(
      CUKII_MEMORY_SECRET_KEY,
      JSON.stringify({
        endpoint: "https://box.example.test/mcp",
        token: "f".repeat(43),
      }),
    );
    const empty = { written: [], unchanged: [], failed: [] };
    let attempts = 0;
    const log: string[] = [];
    const controller = new CukiiMemoryAccountController(
      store,
      extensionRoot(),
      process.execPath,
      vi.fn() as unknown as typeof fetch,
      { ensure: vi.fn(() => true), remove: vi.fn() },
      {
        fetch: async () => {
          throw new Error("box unreachable");
        },
        bundled: () => {
          attempts += 1;
          throw new Error("bundled asset missing");
        },
        install: () => ({ ...empty, written: ["CLAUDE.md"] }),
        remove: () => empty,
      },
      (line) => log.push(line),
    );

    // Fail-open: a dead box must not block the vendor CLI from starting.
    expect(await controller.ensureForModel("claude-opus-5")).toBe(true);
    expect(attempts).toBe(1);
    expect(controller.lastDisciplineOutcome()).toMatchObject({
      source: "none",
      error: "bundled asset missing",
    });
    // A rejected attempt is not memoized, so the next spawn tries again.
    expect(await controller.ensureForModel("claude-opus-5")).toBe(true);
    expect(attempts).toBe(2);
    // 🔴 Silence is what made 2.0.134 undiagnosable from any other machine, and
    // the spawn path is exactly where the rejection used to vanish — so assert
    // that this caller reports it, not merely that the reason appears somewhere.
    expect(
      log.filter((line) => line.includes("skipped for this spawn")),
    ).toEqual([
      "discipline skipped for this spawn: bundled asset missing",
      "discipline skipped for this spawn: bundled asset missing",
    ]);
    controller.dispose();
  });

  it("reports why nothing was installed when the box is not connected", async () => {
    const empty = { written: [], unchanged: [], failed: [] };
    const controller = new CukiiMemoryAccountController(
      new MemoryStore(),
      extensionRoot(),
      process.execPath,
      vi.fn() as unknown as typeof fetch,
      { ensure: vi.fn(() => true), remove: vi.fn() },
      // Explicit, even though this run stops before the installer: the default
      // writes into the real ~/.claude/CLAUDE.md, and a test that ever reaches
      // it would edit the contract of whoever runs the suite.
      {
        fetch: async () => "block",
        bundled: () => "shipped-block",
        install: () => empty,
        remove: () => empty,
      },
    );
    const outcome = await controller.installDisciplineNow();
    expect(outcome.source).toBe("none");
    expect(outcome.error).toContain("not connected");
    expect(describeDisciplineOutcome(outcome)).toContain(
      "discipline NOT installed",
    );
    controller.dispose();
  });

  it("takes the discipline back out when the owner disconnects", async () => {
    const store = new MemoryStore();
    await store.store(
      CUKII_MEMORY_SECRET_KEY,
      JSON.stringify({
        endpoint: "https://box.example.test/mcp",
        token: "f".repeat(43),
      }),
    );
    const empty = { written: [], unchanged: [], failed: [] };
    const remove = vi.fn(() => empty);
    const controller = new CukiiMemoryAccountController(
      store,
      extensionRoot(),
      process.execPath,
      vi.fn() as unknown as typeof fetch,
      { ensure: vi.fn(() => true), remove: vi.fn() },
      {
        fetch: async () => "block",
        bundled: () => "bundled-block",
        install: () => empty,
        remove,
      },
    );

    await controller.runAction("logout", {
      promptEndpoint: async () => undefined,
      promptToken: async () => undefined,
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(store.values.get(CUKII_MEMORY_SECRET_KEY)).toBeUndefined();
  });
});

describe("выбор адреса коробки реле памяти", () => {
  const remote = "https://box.cukii.ru/mcp";
  const local = "http://127.0.0.1:8780/mcp";
  const connection = { endpoint: remote, token: "t0ken" };

  /** Ответ НАШЕЙ коробки: 2xx и `serverInfo.name`, по которому её и опознают. */
  const okBox = () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ result: { serverInfo: { name: "cukii-memory" } } }),
    }) as any;

  // 🔴 Почему это вообще проверяется. На машине-коробке настроенный адрес внешний, и запрос
  // к памяти уходит через VPN, VPS и frp-туннель обратно в тот же компьютер. Туннель рвётся
  // при смене адреса выхода AnyConnect: замер 22.09.2026 — три подряд healthz наружу дали
  // 000 за 10,2 с, 000 за 10,2 с и 200 за 0,5 с, тогда как локальный порт отвечал за 0,03 с.
  it("идёт в локальную коробку, когда она принимает наш токен", async () => {
    const calls: string[] = [];
    const fetchStub = (async (url: any, init: any) => {
      calls.push(String(url));
      expect(init.headers.authorization).toBe("Bearer t0ken");
      return okBox();
    }) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    expect(await upstream.choose()).toBe(local);
    expect(calls).toEqual([local]);
  });

  // Цена ошибки здесь не «медленно», а «агент читает и пишет ЧУЖУЮ память», поэтому
  // признаком служит принятый токен, а не доступность порта.
  it("остаётся на внешнем адресе, если локальный порт отверг токен", async () => {
    const fetchStub = (async () => ({ ok: false, status: 401 }) as any) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    expect(await upstream.choose()).toBe(remote);
  });

  it("остаётся на внешнем адресе, если локально никого нет", async () => {
    const fetchStub = (async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    expect(await upstream.choose()).toBe(remote);
  });

  it("не пробует локальный порт перед каждым запросом", async () => {
    let probes = 0;
    const fetchStub = (async () => {
      probes += 1;
      return okBox();
    }) as any;
    let clock = 1_000;
    const upstream = new CukiiMemoryUpstream(
      connection,
      fetchStub,
      () => clock,
    );
    await upstream.choose();
    await upstream.choose();
    clock += 30_000;
    await upstream.choose();
    expect(probes).toBe(1);
    // …но решение не вечное: коробку поднимают и гасят руками.
    clock += 40_000;
    await upstream.choose();
    expect(probes).toBe(2);
  });

  it("не пробует ничего, когда локальный адрес и настроен", async () => {
    let probes = 0;
    const fetchStub = (async () => {
      probes += 1;
      return okBox();
    }) as any;
    const upstream = new CukiiMemoryUpstream(
      { endpoint: local, token: "t0ken" },
      fetchStub,
    );
    expect(await upstream.choose()).toBe(local);
    expect(probes).toBe(0);
  });

  // 🔴 Без этого кэш работает против нас. Реле ловит любую осечку и отдаёт 502; если после
  // отказа решение донашивается до конца TTL, одна упавшая коробка держит память мёртвой
  // целую минуту, хотя второе плечо живо. Поэтому отказ обязан немедленно обнулять выбор.
  it("после отказа выбирает заново, не дожидаясь истечения TTL", async () => {
    let probes = 0;
    let localAlive = true;
    const fetchStub = (async () => {
      probes += 1;
      if (!localAlive) throw new Error("ECONNREFUSED");
      return okBox();
    }) as any;
    let clock = 1_000;
    const upstream = new CukiiMemoryUpstream(
      connection,
      fetchStub,
      () => clock,
    );
    expect(await upstream.choose()).toBe(local);
    expect(probes).toBe(1);

    // Коробка упала, запрос к ней отказал — реле сообщает об этом выбору.
    localAlive = false;
    upstream.invalidate();

    // Секунда спустя, далеко внутри TTL: обязан перепробовать и уйти наружу.
    clock += 1_000;
    expect(await upstream.choose()).toBe(remote);
    expect(probes).toBe(2);
  });

  it("без отказа кэш продолжает работать — invalidate не зовётся сам по себе", async () => {
    let probes = 0;
    const fetchStub = (async () => {
      probes += 1;
      return okBox();
    }) as any;
    let clock = 1_000;
    const upstream = new CukiiMemoryUpstream(
      connection,
      fetchStub,
      () => clock,
    );
    await upstream.choose();
    clock += 1_000;
    await upstream.choose();
    expect(probes).toBe(1);
  });

  // 🔴 F1 из независимого ревью (grok, 22.09.2026). Признаком «наша коробка» был голый
  // response.ok, то есть ЛЮБОЙ 2xx на :8780 — посторонний MCP без авторизации, заглушка,
  // не тот контейнер. Заявленный инвариант «не читать и не писать чужую память» при этом
  // не выполнялся. Рядом в том же файле probeCukiiMemory уже проверял строже.
  it("не принимает за свою коробку чужой 2xx без serverInfo", async () => {
    const fetchStub = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ result: {} }),
      }) as any) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    expect(await upstream.choose()).toBe(remote);
  });

  it("не принимает за свою коробку чужое имя сервера", async () => {
    const fetchStub = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ result: { serverInfo: { name: "other-mcp" } } }),
      }) as any) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    expect(await upstream.choose()).toBe(remote);
  });

  it("не принимает 2xx с JSON-RPC ошибкой", async () => {
    const fetchStub = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ error: { message: "нет доступа" } }),
      }) as any) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    expect(await upstream.choose()).toBe(remote);
  });

  it("не принимает 2xx с телом, которое вообще не JSON", async () => {
    const fetchStub = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        },
      }) as any) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    expect(await upstream.choose()).toBe(remote);
  });

  it("запрещает редирект: иначе зачёлся бы 2xx с чужого origin", async () => {
    let seen: any;
    const fetchStub = (async (_url: any, init: any) => {
      seen = init.redirect;
      return okBox();
    }) as any;
    await new CukiiMemoryUpstream(connection, fetchStub).choose();
    expect(seen).toBe("error");
  });

  // F4: без single-flight два параллельных кадра дают две пробы.
  it("параллельные вызовы делят одну пробу", async () => {
    let probes = 0;
    const fetchStub = (async () => {
      probes += 1;
      await new Promise((r) => setTimeout(r, 5));
      return okBox();
    }) as any;
    const upstream = new CukiiMemoryUpstream(connection, fetchStub);
    const [a, b, c] = await Promise.all([
      upstream.choose(),
      upstream.choose(),
      upstream.choose(),
    ]);
    expect([a, b, c]).toEqual([local, local, local]);
    expect(probes).toBe(1);
  });

  // 🔴 F4, опасный порядок из ревью: кадр отказал и сбросил выбор, но проба, стартовавшая
  // ДО сброса, возвращается позже и снова объявляет плечо живым. Получается пила.
  it("проба, стартовавшая до сброса, не воскрешает отказавшее плечо", async () => {
    let release: (() => void) | undefined;
    const fetchStub = (async () => {
      await new Promise<void>((r) => (release = r));
      return okBox();
    }) as any;
    let clock = 1_000;
    const upstream = new CukiiMemoryUpstream(
      connection,
      fetchStub,
      () => clock,
    );

    const pending = upstream.choose();
    // Пока проба висит, реальный кадр отказал.
    upstream.invalidate();
    release!();
    await pending;

    // Решение записаться не должно: следующий выбор обязан пробовать заново.
    expect((upstream as any).decided).toBeUndefined();
  });
});

// 🔴 Ревью показало, что мутант «убрать this.upstream.invalidate() из catch реле» не
// краснел: тесты звали invalidate() сами и проверяли метод, а не проводку. Здесь
// проверяется именно связь «плечо отказало -> выбор сброшен».
describe("реле сбрасывает выбор плеча по факту отказа", () => {
  const remote = "https://box.cukii.ru/mcp";
  const connection = { endpoint: remote, token: "t0ken" };

  const makeRelay = (httpFetch: any) =>
    new CukiiMemoryRelay(connection, "proxy.js", "node", httpFetch);

  /** Ставит решение как будто проба уже прошла, гоняет один кадр и возвращает выбор после. */
  const decidedAfterOneFrame = async (relay: any) => {
    const upstream = relay.upstream as any;
    upstream.decided = remote;
    upstream.decidedAt = Date.now();
    try {
      await relay.fetchUpstream(
        remote,
        Buffer.from("{}"),
        new AbortController().signal,
      );
    } catch {
      /* сетевой отказ пробрасывается наружу — здесь нас интересует только выбор */
    }
    return upstream.decided;
  };

  it("HTTP 502 от плеча сбрасывает выбор, хотя fetch не бросает", async () => {
    const relay: any = makeRelay(async () => ({
      ok: false,
      status: 502,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    expect(await decidedAfterOneFrame(relay)).toBeUndefined();
  });

  it("успешный ответ плеча выбор не сбрасывает", async () => {
    const relay: any = makeRelay(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    expect(await decidedAfterOneFrame(relay)).toBe(remote);
  });

  it("сетевой отказ плеча сбрасывает выбор", async () => {
    const relay: any = makeRelay(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await decidedAfterOneFrame(relay)).toBeUndefined();
  });
});
