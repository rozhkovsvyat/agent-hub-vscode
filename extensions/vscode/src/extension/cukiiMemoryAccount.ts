import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import path from "node:path";
import type * as vscode from "vscode";

import type {
  BrokerVendorAuthAction,
  BrokerVendorAuthStatus,
  BrokerVendorId,
} from "core/protocol/ideWebview";
import { brokerVendorForModel } from "core/cukiiPermissionModes";

import type { ProtectedSecretStore } from "@cukii/vendor-bridge";
import {
  bundledDisciplineBlock,
  fetchDisciplineBlock,
  installDisciplineBlock,
  removeDisciplineBlock,
  type DisciplineInstallReport,
} from "./cukiiMemoryDiscipline";
import {
  ensureCukiiMemoryVendorMcp,
  removeCukiiMemoryVendorMcp,
  type CukiiMemoryRelayDescriptor,
} from "./cukiiMemoryVendorMcp";

export const CUKII_MEMORY_ACCOUNT_ID = "memory" as const;
export const CUKII_MEMORY_SECRET_KEY = "cukii.memory.connection";
export const CUKII_MEMORY_DEFAULT_ENDPOINT = "https://box.cukii.ru/mcp";

/**
 * Коробка, стоящая на этой же машине.
 *
 * 🔴 ЗАЧЕМ ВООБЩЕ ВЫБОР. Настроенный адрес — внешний, и на машине-коробке это значит, что
 * запрос к памяти уходит наружу: через корпоративный VPN, через VPS, через frp-туннель и
 * обратно в тот же компьютер. Туннель рвётся при смене адреса выхода AnyConnect, и в момент
 * разрыва внешний адрес отдаёт ничего за 10 с, тогда как локальный порт в ту же секунду
 * отвечает за доли секунды. Замер 22.09.2026: три подряд запроса `healthz` наружу — 000 за
 * 10,2 с, 000 за 10,2 с, 200 за 0,5 с; локально в это же время 200 за 0,03 с. Пользователь
 * видит это как «память отвалилась», хотя она стоит рядом и здорова.
 *
 * 🔴 ПОЧЕМУ ПРОВЕРКА ТОКЕНОМ, А НЕ `healthz`. `healthz` отвечает кому угодно, поэтому по нему
 * нельзя отличить СВОЮ коробку от чужого сервиса, случайно занявшего тот же порт, — а цена
 * ошибки здесь не «медленно», а «агент читает и пишет чужую память». Пробуем `initialize` с
 * тем же bearer: успех означает, что на локальном порту стоит коробка, принимающая наш токен.
 */
const CUKII_MEMORY_LOCAL_ENDPOINT = "http://127.0.0.1:8780/mcp";
/** Проба короткая намеренно: она стоит перед каждым запросом, пока решение не закэшировано. */
const LOCAL_PROBE_TIMEOUT_MS = 500;
/** Решение живёт минуту: коробку поднимают и гасят руками, но не чаще. */
const LOCAL_PROBE_TTL_MS = 60_000;

const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;
const ALL_MEMORY_VENDORS: BrokerVendorId[] = [
  "claude",
  "codex",
  "cursor",
  "grok",
  "kimi",
  "qwen",
];

type MemoryConnection = { endpoint: string; token: string };

export type CukiiMemoryAuthHost = {
  promptEndpoint(defaultValue: string): PromiseLike<string | undefined>;
  promptToken(): PromiseLike<string | undefined>;
};

type MemoryVendorMcp = {
  ensure(
    vendor: BrokerVendorId,
    descriptor: CukiiMemoryRelayDescriptor,
  ): boolean;
  remove(vendor: BrokerVendorId): void;
};

type MemoryDiscipline = {
  fetch(
    endpoint: string,
    token: string,
    httpFetch: MemoryFetch,
  ): Promise<string>;
  bundled(extensionPath: string): string;
  install(block: string): DisciplineInstallReport;
  remove(): DisciplineInstallReport;
};

type MemoryFetch = typeof fetch;

/** What the last discipline attempt actually did, for the owner to read. */
export type DisciplineOutcome = {
  source: "box" | "bundled" | "none";
  written: string[];
  unchanged: string[];
  failed: { target: string; reason: string }[];
  /** Why the box copy was not used; empty when the box answered. */
  boxError?: string;
  /** Why nothing was installed at all. */
  error?: string;
};

/**
 * How long a window keeps an unfinished discipline run before trying again.
 *
 * 🔴 Both extremes are defects. Never retrying is what 2.0.135 shipped: a
 * single failed request pinned the window to the copy inside the VSIX, so an
 * edit in the vault stopped reaching a machine that stayed open for days.
 * Retrying on every message would mean one request to the box per chat turn.
 */
const DISCIPLINE_RETRY_MS = 5 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function describeDisciplineOutcome(outcome: DisciplineOutcome): string {
  if (outcome.error) return `discipline NOT installed: ${outcome.error}`;
  const touched = outcome.written.length + outcome.unchanged.length;
  const head = `discipline in ${touched} agent files from the ${outcome.source} copy`;
  const box = outcome.boxError ? `; box unavailable: ${outcome.boxError}` : "";
  const failed = outcome.failed.length
    ? `; ${outcome.failed
        .map((entry) => `${entry.target}: ${entry.reason}`)
        .join(", ")}`
    : "";
  return `${head}${box}${failed}`;
}

function parseConnection(
  raw: string | undefined,
): MemoryConnection | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<MemoryConnection>;
    if (
      typeof parsed.endpoint !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return undefined;
    }
    return {
      endpoint: normalizeMemoryEndpoint(parsed.endpoint),
      token: validateMemoryToken(parsed.token),
    };
  } catch {
    return undefined;
  }
}

export function normalizeMemoryEndpoint(value: string): string {
  const url = new URL(value.trim());
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error(
      "Cukii Box must use HTTPS (HTTP is allowed only on loopback).",
    );
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "") || "/mcp";
  if (url.pathname === "/") url.pathname = "/mcp";
  if (!url.pathname.endsWith("/mcp")) {
    throw new Error("Cukii Box endpoint must end with /mcp.");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateMemoryToken(value: string): string {
  const token = value.trim();
  if (
    token.length < 32 ||
    token.length > 4096 ||
    /[\x00-\x20\x7f]/.test(token)
  ) {
    throw new Error("Cukii Box token is invalid.");
  }
  return token;
}

/**
 * Выбирает, куда реле отправит запрос: в локальную коробку, если она отвечает на наш токен,
 * иначе — в настроенный адрес. Решение кэшируется, чтобы проба не стояла перед каждым вызовом.
 */
export class CukiiMemoryUpstream {
  private decided: string | undefined;
  private decidedAt = 0;
  /**
   * Счётчик поколений выбора. `invalidate()` его увеличивает, и проба, стартовавшая до
   * сброса, своим результатом решение уже не перезапишет. Без этого проба успевала
   * «оживить» плечо, которое только что отказало на реальном кадре, и получалась пила.
   */
  private generation = 0;
  /** Один in-flight выбор на экземпляр: параллельные кадры не плодят проб. */
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly connection: MemoryConnection,
    private readonly httpFetch: MemoryFetch,
    private readonly now: () => number = () => Date.now(),
    private readonly localEndpoint: string = CUKII_MEMORY_LOCAL_ENDPOINT,
  ) {}

  async choose(): Promise<string> {
    // Настроен уже локальный адрес — пробовать нечего.
    if (this.connection.endpoint === this.localEndpoint)
      return this.localEndpoint;
    if (this.decided && this.now() - this.decidedAt < LOCAL_PROBE_TTL_MS) {
      return this.decided;
    }
    if (this.inFlight) return this.inFlight;
    const startedAt = this.generation;
    this.inFlight = (async () => {
      try {
        const local = await this.localIsOurBox();
        const chosen = local ? this.localEndpoint : this.connection.endpoint;
        // Пока мы пробовали, кадр мог отказать и сбросить выбор. Результат устаревшей
        // пробы не записываем — но этому кадру он всё ещё годится как адрес.
        if (startedAt === this.generation) {
          this.decided = chosen;
          this.decidedAt = this.now();
        }
        return chosen;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }

  /**
   * Забыть выбранный адрес. Зовётся, когда запрос к нему только что отказал — и отказом
   * считается не только брошенное исключение, но и HTTP-статус ошибки: иначе одна осечка
   * коробки держит нас на мёртвом плече до истечения TTL, хотя второе плечо живо.
   */
  invalidate(): void {
    this.decided = undefined;
    this.decidedAt = 0;
    this.generation += 1;
  }

  /**
   * 🔴 Признак — не «порт ответил», а «это НАША коробка». Цена ошибки здесь не медленный
   * запрос, а агент, читающий и пишущий чужую память, поэтому планка та же, что у
   * `probeCukiiMemory`: 2xx, отсутствие JSON-RPC error и `serverInfo.name === "cukii-memory"`.
   * Голого `response.ok` мало: 2xx отдаст любой посторонний MCP без авторизации, заглушка
   * или не тот контейнер на том же порту.
   */
  private async localIsOurBox(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCAL_PROBE_TIMEOUT_MS);
    try {
      const response = await this.httpFetch(this.localEndpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "cukii-vscode-local-probe", version: "1" },
          },
        }),
        // Редирект увёл бы пробу на другой origin, а зачтён был бы финальный 2xx.
        redirect: "error",
        signal: controller.signal,
      });
      // 401 — на порту КАКАЯ-ТО коробка, но не наша: идём наружу, а не в чужую память.
      if (!response.ok) return false;
      const body = (await response.json()) as {
        result?: { serverInfo?: { name?: unknown } };
        error?: { message?: unknown };
      };
      if (body?.error) return false;
      return body?.result?.serverInfo?.name === "cukii-memory";
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function healthUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/mcp$/, "/healthz");
  return url.toString();
}

export async function probeCukiiMemory(
  connection: MemoryConnection,
  httpFetch: MemoryFetch = fetch,
): Promise<void> {
  const healthController = new AbortController();
  const healthTimer = setTimeout(() => healthController.abort(), 5_000);
  try {
    const health = await httpFetch(healthUrl(connection.endpoint), {
      method: "GET",
      signal: healthController.signal,
    });
    if (!health.ok)
      throw new Error(`Cukii Box health check returned HTTP ${health.status}.`);
  } finally {
    clearTimeout(healthTimer);
  }

  const initController = new AbortController();
  const initTimer = setTimeout(() => initController.abort(), 12_000);
  try {
    const response = await httpFetch(connection.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "cukii-vscode", version: "2.0.130" },
        },
      }),
      signal: initController.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Cukii Box rejected the connection (HTTP ${response.status}).`,
      );
    }
    const body = (await response.json()) as {
      result?: { serverInfo?: { name?: unknown } };
      error?: { message?: unknown };
    };
    if (body.error) {
      throw new Error(
        typeof body.error.message === "string"
          ? body.error.message
          : "Cukii Box rejected initialize.",
      );
    }
    if (body.result?.serverInfo?.name !== "cukii-memory") {
      throw new Error("The endpoint is not a Cukii Box memory server.");
    }
  } finally {
    clearTimeout(initTimer);
  }
}

async function readRequestBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_MCP_BODY_BYTES) throw new Error("MCP request is too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function safeCapabilityMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Экспортируется ради приёмки: проводку «отказ плеча -> сброс выбора» нельзя проверить
// на голом CukiiMemoryUpstream — тест звал бы invalidate() сам и покрывал метод, а не связь.
export class CukiiMemoryRelay {
  private server?: http.Server;
  private descriptorValue?: CukiiMemoryRelayDescriptor;
  private readonly upstream: CukiiMemoryUpstream;

  constructor(
    private readonly connection: MemoryConnection,
    private readonly proxyPath: string,
    private readonly nodePath: string,
    private readonly httpFetch: MemoryFetch,
  ) {
    this.upstream = new CukiiMemoryUpstream(connection, httpFetch);
  }

  /**
   * Единственное место, которое знает об отказе ПЛЕЧА, и потому единственное, которое
   * сбрасывает выбор адреса.
   */
  private async fetchUpstream(
    endpoint: string,
    body: Buffer,
    signal: AbortSignal,
  ) {
    let upstream;
    try {
      upstream = await this.httpFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          "content-type": "application/json",
        },
        body,
        signal,
      });
    } catch (error) {
      // Сеть, отказ соединения, истёкший abort.
      this.upstream.invalidate();
      throw error;
    }
    // 🔴 Отказ приходит и статусом, БЕЗ исключения: fetch не бросает на 4xx/5xx, а Caddy
    // при лежащем туннеле отдаёт ровно 502, не обрывая TCP. Пока этой строки не было,
    // обещание «отказ сбрасывает выбор» держалось только для сетевых ошибок, и самый
    // частый случай — внешнее плечо отвечает 502 — залипал до конца TTL.
    if (!upstream.ok) this.upstream.invalidate();
    return upstream;
  }

  async start(): Promise<CukiiMemoryRelayDescriptor> {
    if (this.descriptorValue) return this.descriptorValue;
    const capability = randomBytes(32).toString("base64url");
    this.server = http.createServer(async (request, response) => {
      try {
        const auth = request.headers.authorization ?? "";
        if (
          request.method !== "POST" ||
          request.url !== "/mcp" ||
          !auth.startsWith("Bearer ") ||
          !safeCapabilityMatch(capability, auth.slice("Bearer ".length))
        ) {
          response.writeHead(401).end();
          return;
        }
        const body = await readRequestBody(request);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 125_000);
        try {
          const upstreamEndpoint = await this.upstream.choose();
          const upstream = await this.fetchUpstream(
            upstreamEndpoint,
            body,
            controller.signal,
          );
          const result = Buffer.from(await upstream.arrayBuffer());
          if (result.length > MAX_MCP_BODY_BYTES) {
            throw new Error("MCP response is too large");
          }
          response.writeHead(upstream.status, {
            "content-type":
              upstream.headers.get("content-type") ?? "application/json",
          });
          response.end(result);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        // 🔴 Здесь НЕ сбрасываем выбор плеча. В этот catch попадает и то, что к плечу
        // отношения не имеет: неразобранное тело клиента, слишком большой ответ, отказ
        // авторизации самого реле. Сброс отсюда означал бы, что один толстый кадр одного
        // вендора перекидывает на другое плечо всех остальных. Сбрасывает только тот, кто
        // видел отказ плеча, — fetchUpstream.
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message
                : "Cukii memory relay failed",
          }),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      this.dispose();
      throw new Error("Cukii memory relay did not bind a loopback port.");
    }
    this.descriptorValue = {
      url: `http://127.0.0.1:${address.port}/mcp`,
      capability,
      proxyPath: this.proxyPath,
      nodePath: this.nodePath,
    };
    return this.descriptorValue;
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.descriptorValue = undefined;
  }
}

export class CukiiMemoryAccountController {
  private relay?: CukiiMemoryRelay;
  private relayConnection?: string;
  private disciplineRun?: Promise<DisciplineOutcome>;
  private disciplineOutcome?: DisciplineOutcome;
  private disciplineRetryAfter?: number;

  constructor(
    private readonly store: ProtectedSecretStore,
    private readonly extensionPath: string,
    private readonly nodePath = process.execPath,
    private readonly httpFetch: MemoryFetch = fetch,
    private readonly vendorMcp: MemoryVendorMcp = {
      ensure: (vendor, descriptor) =>
        ensureCukiiMemoryVendorMcp(vendor, descriptor),
      remove: (vendor) => removeCukiiMemoryVendorMcp(vendor),
    },
    private readonly discipline: MemoryDiscipline = {
      fetch: (endpoint, token, httpFetch) =>
        fetchDisciplineBlock(endpoint, token, httpFetch),
      bundled: (extensionPath) => bundledDisciplineBlock(extensionPath),
      install: (block) => installDisciplineBlock(block),
      remove: () => removeDisciplineBlock(),
    },
    private readonly log: (line: string) => void = () => {},
  ) {}

  /**
   * The last thing the discipline actually did on this machine.
   *
   * 🔴 2.0.134 returned this information to nobody: the only caller swallowed
   * the rejection, so a machine with no contract and a machine with a fresh one
   * looked identical from the outside — including to the agent asked to explain
   * it. Whatever fails next has to be readable without a debugger.
   */
  lastDisciplineOutcome(): DisciplineOutcome | undefined {
    return this.disciplineOutcome;
  }

  /**
   * Install the discipline once per activation, and try again later when the
   * run did not finish the job.
   *
   * 🔴 It runs from `ensureForModel`, not only from the Log in button. An owner
   * who connected under 2.0.133 never presses Connect again, so wiring this to
   * the button alone would ship the fix to nobody already affected.
   */
  private async ensureDiscipline(refresh = false): Promise<DisciplineOutcome> {
    if (refresh || this.disciplineDue()) this.disciplineRun = undefined;
    if (!this.disciplineRun) {
      this.disciplineRetryAfter = undefined;
      this.disciplineRun = (async () => {
        const connection = await this.connection();
        if (!connection) throw new Error("Cukii Box is not connected.");

        // The box is the source of truth so a vault edit reaches every machine,
        // but it is no longer the only way in: falling back to the shipped copy
        // is what keeps a blinking network from costing the whole contract.
        let block: string;
        let source: DisciplineOutcome["source"] = "box";
        let boxError: string | undefined;
        try {
          block = await this.discipline.fetch(
            connection.endpoint,
            connection.token,
            this.httpFetch,
          );
        } catch (error: unknown) {
          boxError = errorText(error);
          this.log(`box copy unavailable: ${boxError}`);
          block = this.discipline.bundled(this.extensionPath);
          source = "bundled";
        }

        const report = this.discipline.install(block);
        const outcome: DisciplineOutcome = { source, boxError, ...report };
        this.record(outcome);
        // 🔴 Only a run that reached the box and wrote everywhere is finished.
        // 2.0.135 memoized the fallback as a success, so one failed request
        // pinned the window to the copy inside the VSIX until it was reopened —
        // a vault edit stopped arriving, and a target that was locked at that
        // moment never got a second chance.
        if (source !== "box" || report.failed.length > 0) {
          this.disciplineRetryAfter = Date.now() + DISCIPLINE_RETRY_MS;
        }
        return outcome;
      })().catch((error: unknown) => {
        // A transient outage must not disable discipline for the whole session.
        this.disciplineRun = undefined;
        this.record({
          source: "none",
          written: [],
          unchanged: [],
          failed: [],
          error: errorText(error),
        });
        throw error;
      });
    }
    return this.disciplineRun;
  }

  private record(outcome: DisciplineOutcome): void {
    this.disciplineOutcome = outcome;
    this.log(describeDisciplineOutcome(outcome));
  }

  /** An unfinished run is retried — but not once per message. */
  private disciplineDue(): boolean {
    return (
      this.disciplineRetryAfter !== undefined &&
      Date.now() >= this.disciplineRetryAfter
    );
  }

  /**
   * Install the discipline now and say what happened.
   *
   * Reached from activation and from the `Cukii: Install Memory Discipline`
   * command, so an owner whose machine ended up without the contract has a way
   * to both fix it and see the reason, on a machine nobody can debug remotely.
   */
  async installDisciplineNow(): Promise<DisciplineOutcome> {
    try {
      return await this.ensureDiscipline(true);
    } catch (error: unknown) {
      // Return the reason this run failed, not the shared field: an activation
      // run finishing in parallel would otherwise answer for the command.
      return {
        source: "none",
        written: [],
        unchanged: [],
        failed: [],
        error: errorText(error),
      };
    }
  }

  private async connection(): Promise<MemoryConnection | undefined> {
    return parseConnection(await this.store.get(CUKII_MEMORY_SECRET_KEY));
  }

  private async descriptor(): Promise<CukiiMemoryRelayDescriptor | undefined> {
    const connection = await this.connection();
    if (!connection) return undefined;
    const identity = `${connection.endpoint}\n${connection.token}`;
    if (!this.relay || this.relayConnection !== identity) {
      this.relay?.dispose();
      this.relay = new CukiiMemoryRelay(
        connection,
        path.join(this.extensionPath, "out", "cukiiMemoryProxy.js"),
        this.nodePath,
        this.httpFetch,
      );
      this.relayConnection = identity;
    }
    return this.relay.start();
  }

  async status(): Promise<BrokerVendorAuthStatus> {
    const connection = await this.connection();
    if (!connection) {
      return {
        id: CUKII_MEMORY_ACCOUNT_ID,
        label: "Cukii Box",
        group: "memory",
        installed: true,
        authenticated: false,
        state: "disconnected",
        actions: ["login"],
      };
    }
    try {
      await probeCukiiMemory(connection, this.httpFetch);
      await this.descriptor();
      return {
        id: CUKII_MEMORY_ACCOUNT_ID,
        label: "Cukii Box",
        group: "memory",
        installed: true,
        authenticated: true,
        state: "connected",
        accountLabel: new URL(connection.endpoint).host,
        actions: ["logout"],
      };
    } catch {
      return {
        id: CUKII_MEMORY_ACCOUNT_ID,
        label: "Cukii Box",
        group: "memory",
        installed: true,
        authenticated: false,
        state: "unknown",
        accountLabel: "Connection unavailable",
        actions: ["logout"],
      };
    }
  }

  async runAction(
    action: BrokerVendorAuthAction,
    host: CukiiMemoryAuthHost,
  ): Promise<{ opened: boolean; message: string }> {
    if (action === "logout") {
      await this.store.delete(CUKII_MEMORY_SECRET_KEY);
      this.relay?.dispose();
      this.relay = undefined;
      this.relayConnection = undefined;
      this.disciplineRun = undefined;
      this.disciplineRetryAfter = undefined;
      for (const vendor of ALL_MEMORY_VENDORS) this.vendorMcp.remove(vendor);
      this.discipline.remove();
      return { opened: false, message: "Cukii Box disconnected." };
    }
    if (action !== "login") {
      return { opened: false, message: "This memory action is not supported." };
    }
    const endpointInput = await host.promptEndpoint(
      CUKII_MEMORY_DEFAULT_ENDPOINT,
    );
    if (!endpointInput)
      return { opened: false, message: "Connection cancelled." };
    const tokenInput = await host.promptToken();
    if (!tokenInput) return { opened: false, message: "Connection cancelled." };
    const connection = {
      endpoint: normalizeMemoryEndpoint(endpointInput),
      token: validateMemoryToken(tokenInput),
    };
    await probeCukiiMemory(connection, this.httpFetch);
    await this.store.store(CUKII_MEMORY_SECRET_KEY, JSON.stringify(connection));
    this.relay?.dispose();
    this.relay = undefined;
    this.relayConnection = undefined;
    const descriptor = await this.descriptor();
    if (!descriptor) throw new Error("Cukii Box connection was not stored.");
    const configured = ALL_MEMORY_VENDORS.filter((vendor) =>
      this.vendorMcp.ensure(vendor, descriptor),
    );
    // Connecting the memory without the discipline is what 2.0.133 shipped:
    // the agent could read the vault but never learned it had to. Report the
    // outcome instead of implying it, so a silent failure stays visible.
    let disciplineNote = "";
    try {
      const outcome = await this.ensureDiscipline(true);
      const touched = outcome.written.length + outcome.unchanged.length;
      disciplineNote =
        outcome.failed.length > 0
          ? ` Discipline installed in ${touched} agent files, ${outcome.failed.length} failed.`
          : ` Discipline installed in ${touched} agent files.`;
    } catch (error) {
      disciplineNote = ` Discipline not installed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    return {
      opened: false,
      message: `Cukii Box connected for ${configured.length} vendor CLIs.${disciplineNote}`,
    };
  }

  async ensureForModel(model: string): Promise<boolean> {
    const descriptor = await this.descriptor();
    if (!descriptor) return false;
    const vendor = brokerVendorForModel(model);
    const configured = this.vendorMcp.ensure(vendor, descriptor);
    // Fail-open: a CLI must still start when the discipline cannot be written —
    // but the reason is recorded, never discarded. Swallowing it is exactly how
    // 2.0.134 shipped a silent no-op that read as success.
    await this.ensureDiscipline().catch((error: unknown) => {
      this.log(`discipline skipped for this spawn: ${errorText(error)}`);
    });
    return configured;
  }

  dispose(): void {
    this.relay?.dispose();
  }
}

export function isCukiiMemoryAccountId(
  id: string,
): id is typeof CUKII_MEMORY_ACCOUNT_ID {
  return id === CUKII_MEMORY_ACCOUNT_ID;
}

const CONTROLLERS = new WeakMap<object, CukiiMemoryAccountController>();

export function cukiiMemoryAccountForContext(
  context: Pick<
    vscode.ExtensionContext,
    "secrets" | "extensionPath" | "subscriptions"
  >,
  log?: (line: string) => void,
): CukiiMemoryAccountController {
  const existing = CONTROLLERS.get(context);
  if (existing) return existing;
  const controller = new CukiiMemoryAccountController(
    context.secrets,
    context.extensionPath,
    undefined,
    undefined,
    undefined,
    undefined,
    log,
  );
  CONTROLLERS.set(context, controller);
  context.subscriptions.push({ dispose: () => controller.dispose() });
  // 🔴 Install on activation, not only when a vendor CLI is spawned. In 2.0.134
  // the single trigger sat behind a chat spawn, so any machine where that path
  // did not reach the installer stayed without the contract and said nothing.
  void controller.installDisciplineNow().catch(() => undefined);
  return controller;
}
