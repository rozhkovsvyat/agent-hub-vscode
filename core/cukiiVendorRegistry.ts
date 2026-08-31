export const CUKII_VENDOR_REGISTRY = [
  { id: "claude", label: "Anthropic" },
  { id: "codex", label: "OpenAI" },
  { id: "grok", label: "xAI" },
  { id: "cursor", label: "Cursor" },
  { id: "kimi", label: "Moonshot AI" },
  { id: "qwen", label: "Alibaba" },
  { id: "deepseek", label: "DeepSeek" },
] as const;

export type BrokerVendorId = (typeof CUKII_VENDOR_REGISTRY)[number]["id"];

export function cukiiVendorLabel(vendor: BrokerVendorId): string {
  return (
    CUKII_VENDOR_REGISTRY.find((candidate) => candidate.id === vendor)?.label ??
    vendor
  );
}
