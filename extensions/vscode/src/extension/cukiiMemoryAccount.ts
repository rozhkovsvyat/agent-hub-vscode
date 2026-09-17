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

import type { ProtectedSecretStore } from "./alibabaTokenPlan";
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

class CukiiMemoryRelay {
  private server?: http.Server;
  private descriptorValue?: CukiiMemoryRelayDescriptor;

  constructor(
    private readonly connection: MemoryConnection,
    private readonly proxyPath: string,
    private readonly nodePath: string,
    private readonly httpFetch: MemoryFetch,
  ) {}

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
          const upstream = await this.httpFetch(this.connection.endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.connection.token}`,
              "content-type": "application/json",
            },
            body,
            signal: controller.signal,
          });
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
  private disciplineRun?: Promise<DisciplineInstallReport>;
  private disciplineOutcome?: DisciplineOutcome;

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
   * Install the discipline once per activation, and retry on the next spawn if
   * the box was briefly unreachable.
   *
   * 🔴 It runs from `ensureForModel`, not only from the Log in button. An owner
   * who connected under 2.0.133 never presses Connect again, so wiring this to
   * the button alone would ship the fix to nobody already affected.
   */
  private async ensureDiscipline(
    refresh = false,
  ): Promise<DisciplineInstallReport> {
    if (refresh) this.disciplineRun = undefined;
    if (!this.disciplineRun) {
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
        this.record({ source, boxError, ...report });
        return report;
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

  /**
   * Install the discipline now and say what happened.
   *
   * Reached from activation and from the `Cukii: Install Memory Discipline`
   * command, so an owner whose machine ended up without the contract has a way
   * to both fix it and see the reason, on a machine nobody can debug remotely.
   */
  async installDisciplineNow(): Promise<DisciplineOutcome> {
    try {
      await this.ensureDiscipline(true);
    } catch {
      // `record` already captured the reason; the outcome below carries it.
    }
    return (
      this.disciplineOutcome ?? {
        source: "none",
        written: [],
        unchanged: [],
        failed: [],
        error: "Cukii Box is not connected.",
      }
    );
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
      const report = await this.ensureDiscipline(true);
      const touched = report.written.length + report.unchanged.length;
      disciplineNote =
        report.failed.length > 0
          ? ` Discipline installed in ${touched} agent files, ${report.failed.length} failed.`
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
