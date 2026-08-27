import type {
  BrokerModel,
  BrokerSubagent,
} from "../../redux/slices/sessionSlice";

export type VendorId =
  | "claude"
  | "codex"
  | "xai"
  | "cursor"
  | "kimi"
  | "deepseek";

export interface ModelInfo {
  value: BrokerModel;
  label: string;
  /** If true, the model is shown but cannot be selected (e.g. not wired yet). */
  disabled?: boolean;
}

export interface VendorInfo {
  id: VendorId;
  label: string;
  models: ModelInfo[];
}

export const VENDORS: VendorInfo[] = [
  {
    id: "claude",
    label: "Claude",
    models: [
      { value: "opus-5", label: "Opus 5" },
      { value: "sonnet-5", label: "Sonnet 5" },
      { value: "fable-5", label: "Fable 5" },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    models: [
      { value: "codex-5-6-sol", label: "5.6 Sol" },
      { value: "codex-5-6-terra", label: "5.6 Terra" },
    ],
  },
  {
    id: "xai",
    label: "XAI",
    models: [{ value: "grok-4-6", label: "Grok 4.6" }],
  },
  {
    id: "cursor",
    label: "Cursor",
    models: [{ value: "composer-2-5", label: "Composer 2.5" }],
  },
  {
    id: "kimi",
    label: "Moonshot",
    models: [
      { value: "kimi-k2", label: "Kimi K2.7" },
      { value: "kimi-k3", label: "Kimi K3" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    models: [{ value: "deepseek-v4-pro", label: "V4 Pro", disabled: true }],
  },
];

export const ALL_MODELS: ModelInfo[] = VENDORS.flatMap((v) => v.models);

export const BROKER_MODEL_OPTIONS = ALL_MODELS.filter((m) => !m.disabled);

export const BROKER_SUBAGENT_OPTIONS: Array<{
  value: BrokerSubagent;
  label: string;
}> = [{ value: "auto", label: "Auto" }, ...BROKER_MODEL_OPTIONS];

export function vendorForModel(model: BrokerModel): VendorInfo | undefined {
  return VENDORS.find((vendor) => vendor.models.some((m) => m.value === model));
}

export function modelInfo(model: BrokerModel): ModelInfo | undefined {
  return ALL_MODELS.find((m) => m.value === model);
}
