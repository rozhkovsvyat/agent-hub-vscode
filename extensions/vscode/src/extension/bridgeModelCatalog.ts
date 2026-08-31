import { execFile } from "child_process";
import { alibabaChatCatalog } from "core/cukiiAlibabaCatalog";
import {
  CUKII_VENDOR_REGISTRY,
  cukiiVendorLabel,
} from "core/cukiiVendorRegistry";
import {
  canonicalCukiiModelDescription,
  canonicalCukiiModelLabel,
} from "core/cukiiModelPresentation";
import type {
  BrokerModelCatalogEntry,
  BrokerVendorId,
  BrokerVendorModelCatalog,
} from "core/protocol/ideWebview";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { listBrokerVendorAccounts } from "./bridgeVendorAuth";

const execFileAsync = promisify(execFile);

const FALLBACK_MODELS: Record<BrokerVendorId, BrokerModelCatalogEntry[]> = {
  claude: [
    { value: "opus-5", label: "Opus 5", contextWindowLabel: "1M" },
    { value: "sonnet-5", label: "Sonnet 5", contextWindowLabel: "1M" },
    { value: "fable-5", label: "Fable 5", contextWindowLabel: "1M" },
    {
      value: "haiku-4-5",
      label: "Haiku 4.5",
      contextWindowLabel: "200K",
    },
  ],
  codex: [
    {
      value: "codex-5-6-sol",
      label: "GPT-5.6 Sol",
      contextWindowLabel: "272K",
    },
    {
      value: "codex-5-6-terra",
      label: "GPT-5.6 Terra",
      contextWindowLabel: "272K",
    },
    {
      value: "codex-5-6-luna",
      label: "GPT-5.6 Luna",
      contextWindowLabel: "272K",
    },
    { value: "codex-5-5", label: "GPT-5.5", contextWindowLabel: "272K" },
    { value: "codex-5-4", label: "GPT-5.4", contextWindowLabel: "272K" },
    {
      value: "codex-5-4-mini",
      label: "GPT-5.4 Mini",
      contextWindowLabel: "272K",
    },
  ],
  grok: [
    { value: "grok-4-6", label: "Grok 4.6", contextWindowLabel: "500K" },
    { value: "grok-4-5", label: "Grok 4.5", contextWindowLabel: "500K" },
  ],
  cursor: [
    {
      value: "composer-2-5",
      label: "Composer 2.5",
      contextWindowLabel: "200K",
    },
  ],
  kimi: [
    {
      value: "kimi-k2",
      label: "Kimi K2.7 Coding",
      contextWindowLabel: "256K",
    },
    {
      value: "kimi-k2-highspeed",
      label: "Kimi K2.7 Coding Highspeed",
      contextWindowLabel: "256K",
    },
    { value: "kimi-k3", label: "Kimi K3", contextWindowLabel: "1M" },
    {
      value: "kimi-k3-256k",
      label: "Kimi K3-256K",
      contextWindowLabel: "256K",
    },
  ],
  qwen: alibabaChatCatalog(),
  deepseek: [
    {
      value: "deepseek-v4-pro",
      label: "V4 Pro",
      contextWindowLabel: "1M",
      disabled: true,
    },
  ],
};

const CODEX_MODEL_IDS: Record<string, string> = {
  "gpt-5.6-sol": "codex-5-6-sol",
  "gpt-5.6-terra": "codex-5-6-terra",
  "gpt-5.6-luna": "codex-5-6-luna",
  "gpt-5.5": "codex-5-5",
  "gpt-5.4": "codex-5-4",
  "gpt-5.4-mini": "codex-5-4-mini",
};

const CODEX_CONTEXT: Record<string, string> = {
  // The current Codex CLI route exposes the standard 272K window.  The 1M
  // Codex capability is experimental opt-in and is not enabled by Cukii.
  "gpt-5.6-sol": "272K",
  "gpt-5.6-terra": "272K",
  "gpt-5.6-luna": "272K",
  "gpt-5.5": "272K",
  "gpt-5.4": "272K",
  "gpt-5.4-mini": "272K",
};

const KIMI_MODEL_IDS: Record<string, string> = {
  "kimi-code/kimi-for-coding": "kimi-k2",
  "kimi-code/kimi-for-coding-highspeed": "kimi-k2-highspeed",
  "kimi-code/k3": "kimi-k3",
  "kimi-code/k3-256k": "kimi-k3-256k",
};

const cursorVariantsByBase = new Map<string, string[]>();

function cursorBaseId(id: string): string {
  let base = id;
  let previous: string;
  do {
    previous = base;
    base = base.replace(
      /-(?:fast|thinking|none|minimal|low|medium|high|xhigh|max|extra-high)$/,
      "",
    );
  } while (base !== previous);
  return base;
}

function inferredCursorContext(label: string): string {
  const explicit = label.match(/\b(\d+(?:\.\d+)?[KM])\b/i)?.[1];
  if (explicit) return explicit.toUpperCase();
  if (/Grok 4\.[\d.]+/i.test(label)) return "500K";
  if (/Kimi K2\.7/i.test(label)) return "256K";
  if (/Kimi K3/i.test(label)) return "1M";
  if (/Composer 2\.5/i.test(label)) return "200K";
  if (/Gemini 3/i.test(label)) return "1M";
  if (/Claude (?:Opus|Sonnet|Fable)/i.test(label)) return "1M";
  if (/(?:GPT|Codex)[ -]?5(?:\.|\b)/i.test(label)) {
    return /\b(?:Mini|Nano)\b/i.test(label) ? "400K" : "1M";
  }
  if (/GLM 5\.2/i.test(label)) return "200K";
  // Cursor's unannotated families use the standard subscription window.
  return "200K";
}

function cursorBaseLabel(label: string): string {
  return label
    .replace(/\s*\((?:default|current|NO ZDR)\)/gi, "")
    .replace(/\b\d+(?:\.\d+)?[KM]\b/gi, "")
    .replace(
      /\b(?:Extra High|Minimal|Low|Medium|High|Max|None|Fast|Thinking)\b/gi,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function withDescription(
  model: Omit<BrokerModelCatalogEntry, "description"> & {
    description?: string;
  },
): BrokerModelCatalogEntry {
  const label = canonicalCukiiModelLabel(model.value, model.label);
  return {
    ...model,
    label,
    contextWindowLabel: model.contextWindowLabel.trim() || "Unavailable",
    description:
      model.description?.trim() ||
      canonicalCukiiModelDescription(model.value, label),
  };
}

export function cursorCatalogFromOutput(
  raw: string,
): BrokerModelCatalogEntry[] {
  const groups = new Map<
    string,
    { labels: string[]; variants: string[]; contexts: string[] }
  >();
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([^\s]+)\s+-\s+(.+)$/);
    if (!match || match[1] === "auto") continue;
    const [, nativeId, rawLabel] = match;
    const base = cursorBaseId(nativeId);
    const group = groups.get(base) ?? {
      labels: [],
      variants: [],
      contexts: [],
    };
    group.labels.push(cursorBaseLabel(rawLabel));
    group.variants.push(nativeId);
    group.contexts.push(inferredCursorContext(rawLabel));
    groups.set(base, group);
  }
  cursorVariantsByBase.clear();
  return [...groups.entries()].map(([base, group]) => {
    cursorVariantsByBase.set(base, group.variants);
    const label = group.labels.sort((a, b) => a.length - b.length)[0] ?? base;
    const contextWindowLabel =
      group.contexts.find((context) => context !== "Unknown") ?? "Unknown";
    return withDescription({
      value: base === "composer-2.5" ? "composer-2-5" : `cursor:${base}`,
      label,
      contextWindowLabel,
    });
  });
}

export function resolveCursorCatalogModel(
  model: string,
  effort: string,
  speed: "standard" | "fast",
  thinking: boolean,
): string | undefined {
  if (model === "composer-2-5") {
    return speed === "fast" ? "composer-2.5-fast" : "composer-2.5";
  }
  if (!model.startsWith("cursor:")) return undefined;
  const base = model.slice("cursor:".length);
  const variants = cursorVariantsByBase.get(base) ?? [base];
  const effortTokens =
    effort === "ultra"
      ? ["max"]
      : effort === "xhigh"
        ? ["xhigh", "extra-high"]
        : [effort];
  const score = (id: string) => {
    const isFast = id.endsWith("-fast");
    const hasThinking = /-thinking(?:-|$)/.test(id);
    const effortMatch = effortTokens.some((token) =>
      new RegExp(`-${token}(?:-|$)`).test(id),
    );
    return (
      (isFast === (speed === "fast") ? 8 : 0) +
      (hasThinking === thinking ? 4 : 0) +
      (effortMatch ? 2 : 0) -
      Math.abs(id.length - base.length) / 1000
    );
  };
  return [...variants].sort((a, b) => score(b) - score(a))[0];
}

/**
 * A saved chat can be reopened after the extension host restarted, before its
 * model picker has mounted.  Rebuild the native Cursor variant cache before a
 * `cursor:<family>` bridge launch so an old session never sends a decorative
 * base id instead of one of Cursor's real effort/speed ids.
 */
export async function ensureCursorCatalogVariants(
  model: string,
): Promise<void> {
  if (!model.startsWith("cursor:")) return;
  // A restored session cannot use a stale in-memory variant cache as proof
  // that the native Cursor account is still authenticated. Check first so no
  // logged-out/unknown state can invoke `agent models`.
  const cursorConnected = (await listBrokerVendorAccounts()).some(
    (account) => account.id === "cursor" && account.state === "connected",
  );
  if (!cursorConnected)
    throw new Error(
      "Cursor is not signed in. Sign in through Manage subscriptions before reopening this Cursor session.",
    );
  const base = model.slice("cursor:".length);
  if (cursorVariantsByBase.has(base)) return;
  await liveModels("cursor", true);
  if (!cursorVariantsByBase.has(base)) {
    throw new Error(
      `Cursor no longer exposes the saved model family "${base}". Open the model picker and select an available Cursor model.`,
    );
  }
}

function contextLabel(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens)) return "Unknown";
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_048_576)}M`;
  return `${Math.round(tokens / 1024)}K`;
}

function codexContextLabel(tokens: number | undefined, slug: string): string {
  if (tokens && Number.isFinite(tokens) && tokens > 0) {
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
    return `${Math.round(tokens / 1_000)}K`;
  }
  return CODEX_CONTEXT[slug] ?? "Unknown";
}

function codexDisplayName(name: string): string {
  return name.replace(/^(GPT-[\d.]+)-/, "$1 ");
}

export function codexCatalogFromCache(raw: string): BrokerModelCatalogEntry[] {
  const parsed = JSON.parse(raw) as {
    models?: Array<{
      slug?: string;
      display_name?: string;
      description?: string;
      context_window?: number;
      visibility?: string;
    }>;
  };
  return (parsed.models ?? [])
    .filter((model) => model.visibility === "list" && model.slug)
    .map((model) =>
      withDescription({
        value: CODEX_MODEL_IDS[model.slug!] ?? `codex:${model.slug}`,
        label: codexDisplayName(model.display_name ?? model.slug!),
        contextWindowLabel: codexContextLabel(
          model.context_window,
          model.slug!,
        ),
        description: model.description,
      }),
    );
}

export function grokCatalogFromOutput(raw: string): BrokerModelCatalogEntry[] {
  return [...raw.matchAll(/^\s*[*-]\s+(grok-[\w.-]+)/gim)].map((match) => {
    const nativeModel = match[1];
    const legacyValue =
      nativeModel === "grok-4.6"
        ? "grok-4-6"
        : nativeModel === "grok-4.5"
          ? "grok-4-5"
          : undefined;
    return withDescription({
      value: legacyValue ?? `grok:${nativeModel}`,
      label: nativeModel
        .split("-")
        .map((part, index) => (index === 0 ? "Grok" : part))
        .join(" "),
      contextWindowLabel: "500K",
    });
  });
}

export function kimiCatalogFromJson(raw: string): BrokerModelCatalogEntry[] {
  const parsed = JSON.parse(raw) as {
    models?: Record<
      string,
      { displayName?: string; maxContextSize?: number; provider?: string }
    >;
  };
  return Object.entries(parsed.models ?? {})
    .filter(([, model]) => model.provider === "managed:kimi-code")
    .map(([alias, model]) =>
      withDescription({
        value: KIMI_MODEL_IDS[alias] ?? `kimi:${alias}`,
        label: model.displayName ?? alias,
        contextWindowLabel: contextLabel(model.maxContextSize),
      }),
    );
}

async function run(program: string, args: string[]): Promise<string> {
  const command = process.env.ComSpec ?? "cmd.exe";
  const result = await execFileAsync(command, ["/d", "/c", program, ...args], {
    timeout: 12_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout;
}

async function liveModels(
  vendor: BrokerVendorId,
  canUseMaintainedCatalog = false,
): Promise<BrokerModelCatalogEntry[]> {
  // Claude/Qwen have no machine-readable subscription enumeration. Maintained
  // entries are only a usable-account catalog, never a missing-CLI fallback.
  const staticModels = staticCatalogForUnavailableDiscovery(vendor);
  if (staticModels.length > 0) {
    return canUseMaintainedCatalog ? staticModels : [];
  }
  // Discovery and local model caches are account-scoped. Logged-out vendors
  // must neither execute a CLI probe nor leak a previously authenticated cache.
  if (!canUseMaintainedCatalog) return [];
  try {
    if (vendor === "codex") {
      const cache = path.join(os.homedir(), ".codex", "models_cache.json");
      if (fs.existsSync(cache))
        return codexCatalogFromCache(fs.readFileSync(cache, "utf8"));
      return [];
    }
    if (vendor === "grok")
      return grokCatalogFromOutput(await run("grok", ["models"]));
    if (vendor === "kimi")
      return kimiCatalogFromJson(
        await run("kimi", ["provider", "list", "--json"]),
      );
    if (vendor === "cursor") {
      const result = await execFileAsync(
        process.platform === "win32" ? "agent" : "cursor-agent",
        ["models"],
        {
          timeout: 12_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        },
      );
      return cursorCatalogFromOutput(result.stdout);
    }
    return [];
  } catch {
    // A failed live probe is not evidence that fallback models are available.
    // The accounts screen separately explains missing CLI/auth state.
    return [];
  }
}

export function staticCatalogForUnavailableDiscovery(
  vendor: BrokerVendorId,
): BrokerModelCatalogEntry[] {
  return vendor === "claude" || vendor === "qwen"
    ? FALLBACK_MODELS[vendor].map(withDescription)
    : [];
}

export async function listBrokerModelCatalog(): Promise<
  BrokerVendorModelCatalog[]
> {
  const usable = new Set(
    (await listBrokerVendorAccounts())
      .filter((account) => account.state === "connected")
      .map((account) => account.id),
  );
  return Promise.all(
    CUKII_VENDOR_REGISTRY.map(async (vendor) => ({
      id: vendor.id,
      label: cukiiVendorLabel(vendor.id),
      models: await liveModels(vendor.id, usable.has(vendor.id)),
    })),
  );
}
