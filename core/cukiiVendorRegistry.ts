export const CUKII_VENDOR_REGISTRY = [
  { id: "qwen", label: "Alibaba" },
  { id: "claude", label: "Anthropic" },
  { id: "codex", label: "OpenAI" },
  { id: "grok", label: "xAI" },
  { id: "cursor", label: "Cursor" },
  { id: "kimi", label: "MoonshotAI" },
  { id: "deepseek", label: "DeepSeek" },
] as const;

export type BrokerVendorId = (typeof CUKII_VENDOR_REGISTRY)[number]["id"];

/**
 * Vendors whose public API exposes no quota/usage endpoint at all. The usage
 * drawer must say so honestly instead of promising limits after the next run
 * (card 136d1ff1). Kimi and the rest poll live endpoints.
 */
export const CUKII_VENDORS_WITHOUT_USAGE_ENDPOINT: readonly BrokerVendorId[] = [
  "qwen",
];

export function cukiiVendorLabel(vendor: BrokerVendorId): string {
  return (
    CUKII_VENDOR_REGISTRY.find((candidate) => candidate.id === vendor)?.label ??
    vendor
  );
}
