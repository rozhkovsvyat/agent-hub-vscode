import type { BrokerModelCatalogEntry } from "./protocol/ideWebview";

export const ALIBABA_VENDOR_ID = "qwen" as const;
export const ALIBABA_VENDOR_LABEL = "Alibaba";
export const CUKII_DEFAULT_BROKER_MODEL = "qwen-3-8-max";

/** Singapore / international Token Plan compatible-mode endpoint. */
export const ALIBABA_TOKEN_PLAN_REGION = "ap-southeast-1";
export const ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
export const ALIBABA_TOKEN_PLAN_ANTHROPIC_ENDPOINT =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic";
export const ALIBABA_TOKEN_PLAN_ENV_KEY = "BAILIAN_TOKEN_PLAN_API_KEY";
export const ALIBABA_CONSOLE_URL =
  "https://modelstudio.console.alibabacloud.com/ap-southeast-1";

export const VENDOR_ACCOUNT_COPY = {
  login: "Log in",
  logout: "Log out",
  disconnected: "Not logged in",
  connectedFallback: "Connected",
} as const;

export type AlibabaChatKind = "text" | "reasoning" | "vision-chat";
export type AlibabaCapabilityKind =
  | "image"
  | "asr"
  | "tts"
  | "realtime-audio"
  | "i2v"
  | "t2v"
  | "r2v";

export type AlibabaChatModel = {
  value: string;
  nativeId: string;
  label: string;
  contextWindowLabel: "1M";
  kind: AlibabaChatKind;
};

export type AlibabaCapability = {
  id: string;
  kind: AlibabaCapabilityKind;
  label: string;
  /** Only a real Cukii capability route may be wired. Chat picker must not fake these. */
  route: "unsupported";
  availability: "Coming soon";
};

/**
 * Text / reasoning / vision-chat models shown in the Cukii chat picker.
 * Native Token Plan ids are used on the Qwen Code compatible argv, never as
 * a second set of fake picker rows.
 */
export const ALIBABA_CHAT_MODELS: readonly AlibabaChatModel[] = [
  {
    value: "qwen-3-8-max",
    nativeId: "qwen3.8-max",
    label: "Qwen 3.8 Max",
    contextWindowLabel: "1M",
    kind: "reasoning",
  },
  {
    value: "qwen-3-8-flash",
    nativeId: "qwen3.8-flash",
    label: "Qwen 3.8 Flash",
    contextWindowLabel: "1M",
    kind: "text",
  },
  {
    value: "qwen-3-7-plus",
    nativeId: "qwen3.7-plus",
    label: "Qwen 3.7 Plus",
    contextWindowLabel: "1M",
    kind: "vision-chat",
  },
  {
    value: "qwen-3-7-max",
    nativeId: "qwen3.7-max",
    label: "Qwen 3.7 Max",
    contextWindowLabel: "1M",
    kind: "reasoning",
  },
  {
    value: "qwen-3-6-flash",
    nativeId: "qwen3.6-flash",
    label: "Qwen 3.6 Flash",
    contextWindowLabel: "1M",
    kind: "text",
  },
  {
    value: "qwen-deepseek-v4-pro-0813",
    nativeId: "deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro 0813",
    contextWindowLabel: "1M",
    kind: "reasoning",
  },
  {
    value: "qwen-deepseek-v4-pro",
    nativeId: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    contextWindowLabel: "1M",
    kind: "reasoning",
  },
  {
    value: "qwen-deepseek-v4-flash-0731",
    nativeId: "deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash",
    contextWindowLabel: "1M",
    kind: "text",
  },
  {
    value: "qwen-glm-5-2",
    nativeId: "glm-5.2",
    label: "GLM 5.2",
    contextWindowLabel: "1M",
    kind: "reasoning",
  },
];

export const ALIBABA_NON_CHAT_CAPABILITIES: readonly AlibabaCapability[] = [
  {
    id: "qwen-image-3.0-pro",
    kind: "image",
    label: "Qwen Image 3.0 Pro",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "qwen-audio-3.0-asr-flash",
    kind: "asr",
    label: "Qwen Audio ASR Flash",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "qwen-audio-3.0-tts-plus",
    kind: "tts",
    label: "Qwen Audio TTS Plus",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "qwen-audio-3.0-realtime-plus",
    kind: "realtime-audio",
    label: "Qwen Audio Realtime Plus",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "wan2.7-image",
    kind: "image",
    label: "Wan 2.7 Image",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "wan2.7-image-pro",
    kind: "image",
    label: "Wan 2.7 Image Pro",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "happyhorse-1.1-i2v",
    kind: "i2v",
    label: "HappyHorse 1.1 I2V",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "happyhorse-1.1-t2v",
    kind: "t2v",
    label: "HappyHorse 1.1 T2V",
    route: "unsupported",
    availability: "Coming soon",
  },
  {
    id: "happyhorse-1.1-r2v",
    kind: "r2v",
    label: "HappyHorse 1.1 R2V",
    route: "unsupported",
    availability: "Coming soon",
  },
];

const CHAT_BY_VALUE = new Map(
  ALIBABA_CHAT_MODELS.flatMap((model) => [
    [model.value, model],
    [model.nativeId, model],
  ]),
);

const NON_CHAT_IDS = new Set(
  ALIBABA_NON_CHAT_CAPABILITIES.map((item) => item.id),
);

export function alibabaChatCatalog(): BrokerModelCatalogEntry[] {
  return ALIBABA_CHAT_MODELS.map((model) => ({
    value: model.value,
    label: model.label,
    contextWindowLabel: model.contextWindowLabel,
  }));
}

export function alibabaChatNativeIds(): string[] {
  return ALIBABA_CHAT_MODELS.map((model) => model.nativeId);
}

export function isAlibabaChatModel(model: string): boolean {
  // The postponed DeepSeek vendor still owns the bare `deepseek-v4-pro` picker
  // id. Alibaba hosts the same native checkpoint as `qwen-deepseek-v4-pro`.
  if (model === "deepseek-v4-pro") return false;
  if (CHAT_BY_VALUE.has(model)) return true;
  return (
    model.startsWith("qwen:") && !NON_CHAT_IDS.has(model.slice("qwen:".length))
  );
}

export function isAlibabaNonChatCapability(model: string): boolean {
  const raw = model.startsWith("qwen:") ? model.slice("qwen:".length) : model;
  return NON_CHAT_IDS.has(raw);
}

export function alibabaCapabilityAvailability(
  model: string,
): "chat" | "Coming soon" | "unknown" {
  if (isAlibabaChatModel(model) && !isAlibabaNonChatCapability(model)) {
    return "chat";
  }
  if (isAlibabaNonChatCapability(model)) return "Coming soon";
  return "unknown";
}

export function alibabaNativeModelId(model: string): string | undefined {
  if (isAlibabaNonChatCapability(model)) return undefined;
  const mapped = CHAT_BY_VALUE.get(model);
  if (mapped) return mapped.nativeId;
  if (model.startsWith("qwen:")) {
    const alias = model.slice("qwen:".length);
    return CHAT_BY_VALUE.get(alias)?.nativeId ?? alias;
  }
  return undefined;
}

export function classifyAlibabaCatalogId(
  model: string,
): "chat" | "capability-unavailable" | "unknown" {
  if (isAlibabaNonChatCapability(model)) return "capability-unavailable";
  if (isAlibabaChatModel(model)) return "chat";
  return "unknown";
}
