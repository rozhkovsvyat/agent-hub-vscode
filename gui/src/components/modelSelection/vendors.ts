import type {
  BrokerVendorId,
  BrokerVendorModelCatalog,
  BrokerModel,
  BrokerSubagent,
} from "core/protocol/ideWebview";
import { CUKII_VENDOR_REGISTRY } from "core/cukiiVendorRegistry";
import {
  canonicalCukiiModelDescription,
  cukiiCapabilityRating,
} from "core/cukiiModelPresentation";

export type VendorId = BrokerVendorId;

export interface ModelInfo {
  value: BrokerModel;
  label: string;
  contextWindowLabel: string;
  description: string;
  /** If true, the model is shown but cannot be selected (e.g. not wired yet). */
  disabled?: boolean;
}

export interface VendorInfo {
  id: VendorId;
  label: string;
  models: ModelInfo[];
}

type BootstrapVendorInfo = Omit<VendorInfo, "models"> & {
  models: Array<Omit<ModelInfo, "description"> & { description?: string }>;
};

const FALLBACK_VENDORS: BootstrapVendorInfo[] = [
  {
    id: "claude",
    label: "Anthropic",
    models: [
      { value: "opus-5", label: "Opus 5", contextWindowLabel: "1M" },
      { value: "sonnet-5", label: "Sonnet 5", contextWindowLabel: "1M" },
      { value: "fable-5", label: "Fable 5", contextWindowLabel: "1M" },
      {
        value: "haiku-4-5",
        label: "Haiku 4.5",
        contextWindowLabel: "200K",
      },
    ],
  },
  {
    id: "codex",
    label: "OpenAI",
    models: [
      // Match the currently usable Codex CLI route; live metadata can raise it.
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
      {
        value: "codex-5-5",
        label: "GPT-5.5",
        contextWindowLabel: "272K",
      },
      {
        value: "codex-5-4",
        label: "GPT-5.4",
        contextWindowLabel: "272K",
      },
      {
        value: "codex-5-4-mini",
        label: "GPT-5.4 Mini",
        contextWindowLabel: "272K",
      },
    ],
  },
  {
    id: "grok",
    label: "xAI",
    models: [
      { value: "grok-4-6", label: "Grok 4.6", contextWindowLabel: "500K" },
      { value: "grok-4-5", label: "Grok 4.5", contextWindowLabel: "500K" },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    models: [
      {
        value: "composer-2-5",
        label: "Composer 2.5",
        contextWindowLabel: "200K",
      },
    ],
  },
  {
    id: "kimi",
    label: "Moonshot AI",
    models: [
      { value: "kimi-k2", label: "K2.7 Coding", contextWindowLabel: "256K" },
      {
        value: "kimi-k2-highspeed",
        label: "K2.7 Coding Highspeed",
        contextWindowLabel: "256K",
      },
      { value: "kimi-k3", label: "K3", contextWindowLabel: "1M" },
      {
        value: "kimi-k3-256k",
        label: "K3-256K",
        contextWindowLabel: "256K",
      },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: [
      {
        value: "deepseek-v4-pro",
        label: "V4 Pro",
        contextWindowLabel: "1M",
        disabled: true,
      },
    ],
  },
  {
    id: "qwen",
    label: "Alibaba Cloud",
    models: [
      {
        value: "qwen-3-8-max",
        label: "Qwen 3.8 Max",
        contextWindowLabel: "1M",
      },
    ],
  },
];

export const VENDORS: VendorInfo[] = CUKII_VENDOR_REGISTRY.map((registered) => {
  const vendor = FALLBACK_VENDORS.find(
    (candidate) => candidate.id === registered.id,
  );
  if (!vendor) throw new Error(`Missing Cukii vendor ${registered.id}`);
  return {
    ...vendor,
    label: registered.label,
    models: presentVendorModels(vendor.models),
  };
});

export const ALL_MODELS: ModelInfo[] = VENDORS.flatMap((v) => v.models);

export const BROKER_MODEL_OPTIONS = ALL_MODELS.filter((m) => !m.disabled);

export const BROKER_SUBAGENT_OPTIONS: Array<{
  value: BrokerSubagent;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  ...BROKER_MODEL_OPTIONS.map((model) => ({
    value: model.value,
    label: displayModelLabel(model),
  })),
];

export function applyRuntimeVendorCatalog(
  catalog: BrokerVendorModelCatalog[],
): void {
  const byId = new Map(catalog.map((vendor) => [vendor.id, vendor]));
  const next = CUKII_VENDOR_REGISTRY.map((registered) => {
    const live = byId.get(registered.id);
    const fallback = FALLBACK_VENDORS.find(
      (vendor) => vendor.id === registered.id,
    );
    return {
      id: registered.id,
      label: registered.label,
      models: presentVendorModels(live?.models ?? fallback?.models ?? []),
    };
  }).filter((vendor) => vendor.models.length > 0);
  if (next.length === 0) return;
  VENDORS.splice(0, VENDORS.length, ...next);
  ALL_MODELS.splice(0, ALL_MODELS.length, ...VENDORS.flatMap((v) => v.models));
  BROKER_MODEL_OPTIONS.splice(
    0,
    BROKER_MODEL_OPTIONS.length,
    ...ALL_MODELS.filter((model) => !model.disabled),
  );
  BROKER_SUBAGENT_OPTIONS.splice(
    0,
    BROKER_SUBAGENT_OPTIONS.length,
    { value: "auto", label: "Auto" },
    ...BROKER_MODEL_OPTIONS.map((model) => ({
      value: model.value,
      label: displayModelLabel(model),
    })),
  );
}

export function displayModelLabel(model: ModelInfo): string {
  return model.label;
}

/** Product-level capability tier, independent of vendor pricing and context. */
export { cukiiCapabilityRating };

/**
 * Normalizes catalog metadata and orders a vendor's models by Cukii bottle
 * rating. The original catalog index breaks ties, preserving canonical/live
 * vendor order without imposing a name or locale sort.
 */
export function presentVendorModels(
  models: BootstrapVendorInfo["models"],
): ModelInfo[] {
  return models
    .map((model) => ({
      ...model,
      contextWindowLabel: model.contextWindowLabel.trim() || "Unavailable",
      description:
        model.description?.trim() ||
        canonicalCukiiModelDescription(model.value, model.label),
    }))
    .map((model, canonicalIndex) => ({ model, canonicalIndex }))
    .sort(
      (left, right) =>
        cukiiCapabilityRating(right.model) -
          cukiiCapabilityRating(left.model) ||
        left.canonicalIndex - right.canonicalIndex,
    )
    .map(({ model }) => model);
}

export function vendorForModel(model: BrokerModel): VendorInfo | undefined {
  return VENDORS.find((vendor) => vendor.models.some((m) => m.value === model));
}

export function modelInfo(model: BrokerModel): ModelInfo | undefined {
  return ALL_MODELS.find((m) => m.value === model);
}

/** Native vendor acceleration, as opposed to a prompt-level approximation. */
export function supportsNativeSpeed(model: BrokerModel): boolean {
  return (
    model === "opus-5" ||
    model.startsWith("codex-") ||
    model.startsWith("codex:") ||
    model === "composer-2-5" ||
    model.startsWith("cursor:")
  );
}

/** Native reasoning on/off, separate from the effort level. */
export function supportsNativeThinking(model: BrokerModel): boolean {
  return (
    model === "opus-5" ||
    model === "sonnet-5" ||
    model.startsWith("codex-") ||
    model.startsWith("codex:") ||
    model.startsWith("cursor:claude-")
  );
}
