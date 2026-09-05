const CANONICAL_KIMI_MODEL_LABELS: Record<string, string> = {
  "kimi-k2": "Kimi K2.7 Coding",
  "kimi-k2-highspeed": "Kimi K2.7 Coding Highspeed",
  "kimi-k3": "Kimi K3",
  "kimi-k3-256k": "Kimi K3-256K",
};

/**
 * Reseller and maker branding that a CLI puts in front of a product name.
 * Cursor lists Anthropic models as "Claude Opus 5" and its own xAI route as
 * "Cursor Grok 4.6"; the picker already says which CLI a section belongs to,
 * so the prefix is noise that also makes the same model read differently
 * depending on which vendor answered.
 */
const BRANDING_PREFIX = /^(?:claude|cursor)\s+/i;

/** Canonical product name for every model shown by Cukii. */
export function canonicalCukiiModelLabel(value: string, label: string): string {
  const normalizedLabel = label.trim().replace(BRANDING_PREFIX, "");
  const normalizedValue = value.toLowerCase();
  if (
    !normalizedValue.startsWith("kimi-") &&
    !normalizedValue.startsWith("kimi:")
  )
    return normalizedLabel;

  const knownLabel = CANONICAL_KIMI_MODEL_LABELS[normalizedValue];
  if (knownLabel) return knownLabel;

  const unbrandedLabel = normalizedLabel
    .replace(/^kimi(?:[\s:_-]+)?/i, "")
    .trim();
  return `Kimi ${unbrandedLabel || value.slice(value.indexOf(":") + 1)}`;
}

/**
 * Short, factual model-family positioning for the compact Cukii picker.
 * Live CLI metadata takes precedence; this catalog covers static models and
 * CLIs (notably Cursor) that expose an id/label but no description.
 */
export function canonicalCukiiModelDescription(
  value: string,
  label: string,
): string {
  const id = value.toLowerCase().replace(/^cursor:/, "");
  const name = label.toLowerCase();
  const matches = (pattern: RegExp) => pattern.test(id) || pattern.test(name);

  if (matches(/(?:^|[-\s])fable(?:[-\s]|$)/))
    return "Most capable for the hardest, longest-running tasks";
  if (matches(/(?:^|[-\s])opus(?:[-\s]|$)/))
    return "Best for everyday, complex tasks";
  if (matches(/(?:^|[-\s])sonnet(?:[-\s]|$)/))
    return "Efficient for routine development tasks";
  if (matches(/(?:^|[-\s])haiku(?:[-\s]|$)/)) return "Fastest for simple tasks";
  if (matches(/gpt[-\s]?5[.-]6[-\s]sol/))
    return "Latest frontier agentic coding model";
  if (matches(/gpt[-\s]?5[.-]6[-\s]terra/))
    return "Balanced agentic coding model for everyday work";
  if (matches(/gpt[-\s]?5[.-]6[-\s]luna/))
    return "Fast, affordable agentic coding model";
  if (matches(/gpt[-\s]?5[.-]5/))
    return "Frontier model for complex coding and research";
  if (matches(/gpt[-\s]?5[.-]4[-\s]mini/))
    return "Fast, cost-efficient model for simpler coding tasks";
  if (matches(/gpt[-\s]?5[.-]4/)) return "Strong model for everyday coding";
  if (matches(/grok[-\s]?4[.-]6/))
    return "Flagship xAI model for coding and agentic tasks";
  if (matches(/grok[-\s]?4[.-]5/))
    return "Engineering-focused model for coding and agentic software workflows";
  if (matches(/(?:^|[-\s])grok(?:[-\s]|$)/))
    return "xAI model for coding and agentic tasks";
  if (matches(/composer[-\s]?2[.-]5/))
    return "Fast agentic model for long-running coding tasks";
  if (matches(/kimi[-\s]?k3|(?:^|[-\s])k3(?:[-\s]|$)/))
    return /256k/.test(id) || /256k/.test(name)
      ? "Quota-efficient option for routine development"
      : "Flagship for long-horizon coding and knowledge work";
  if (matches(/kimi[-\s]?k2|k2[.-]7/))
    return /highspeed/.test(id) || /highspeed/.test(name)
      ? "Fast option for routine development"
      : "Coding model for completion and routine development";
  if (matches(/qwen[-\s]?3[.-]8[-\s]max/))
    return "Alibaba flagship for tool use and agent workflows";
  if (matches(/qwen[-\s]?3[.-]8[-\s]flash/))
    return "Fast Alibaba model for everyday coding";
  if (matches(/qwen[-\s]?3[.-]7[-\s]plus/))
    return "Vision-capable Alibaba model for coding and screenshots";
  if (matches(/qwen[-\s]?3[.-]7[-\s]max/))
    return "High-capacity Alibaba model for agentic coding";
  if (matches(/qwen[-\s]?3[.-]6[-\s]flash/))
    return "Fast Alibaba model for routine development";
  if (matches(/qwen[-\s]?deepseek[-\s]?v4[-\s]?pro[-\s]?0813/))
    return "Dated DeepSeek Pro checkpoint on Alibaba Token Plan";
  if (matches(/qwen[-\s]?deepseek[-\s]?v4[-\s]?flash/))
    return "Fast DeepSeek model on Alibaba Token Plan";
  if (matches(/qwen[-\s]?deepseek[-\s]?v4[-\s]?pro/))
    return "DeepSeek Pro on Alibaba Token Plan";
  if (matches(/qwen[-\s]?glm[-\s]?5[.-]2/))
    return "GLM reasoning model on Alibaba Token Plan";
  if (matches(/gemini/)) return "Google model available through Cursor";
  if (matches(/glm/)) return "Zhipu reasoning model available through Cursor";
  if (matches(/deepseek/)) return "DeepSeek coding model";
  return "Model available through the vendor CLI";
}

/**
 * Product-level capability tier shown as Cukii bottles in the model picker.
 * Only the curated top group ("Milky") carries bottles: 3 for the flagships,
 * 2 for the strong seconds, 1 for the remaining curated routes. Every other
 * model rates 0 and renders no bottles at all.
 */
export function cukiiCapabilityRating(
  model: Pick<CukiiModelPresentation, "value" | "label">,
): 0 | 1 | 2 | 3 {
  const stableId = model.value.toLowerCase().replace(/^cursor:/, "");
  const fallbackLabel = model.label.toLowerCase();
  const matches = (pattern: RegExp) =>
    pattern.test(stableId) || pattern.test(fallbackLabel);

  if (
    matches(/fable[-\s]?5[.-]1/) ||
    matches(/(?:gpt|codex)[-\s]?5[.-]6[-\s]sol/) ||
    matches(/qwen[-\s]?3[.-]8[-\s]max/)
  ) {
    return 3;
  }
  // Opus earns its bottles as the current generation only: Cursor also resells
  // Opus 4.5-4.8, and a superseded generation is not a Milky route. Kimi K3 is
  // rated, but its quota-saving K3-256K sibling is not.
  if (
    matches(/(?:^|[-\s.])opus[-\s.]?5(?![\d.])/) ||
    (matches(/kimi[-\s]?k3/) && !matches(/256k?(?:[-\s.]|$)/))
  ) {
    return 2;
  }
  if (
    matches(/(?:gpt|codex)[-\s]?5[.-]6[-\s]terra/) ||
    matches(/grok[-\s]?4[.-]6/) ||
    matches(/composer[-\s]?2[.-]5/) ||
    matches(/qwen[-\s]?deepseek[-\s]?v4[-\s]?pro[-\s]?0813/)
  ) {
    return 1;
  }
  return 0;
}

/**
 * The maker behind a route, used to group an aggregating CLI's catalog.
 * Cursor resells eight makers at once, so its section is ordered by maker
 * (alphabetically) and then by bottles — without printing a heading per maker,
 * which would turn one vendor section into eight.
 *
 * An unrecognised model returns "" and sorts after every known maker.
 */
export function cukiiModelUpstreamVendor(
  model: Pick<CukiiModelPresentation, "value" | "label">,
): string {
  const stableId = model.value.toLowerCase().replace(/^cursor:/, "");
  const fallbackLabel = model.label.toLowerCase();
  const matches = (pattern: RegExp) =>
    pattern.test(stableId) || pattern.test(fallbackLabel);

  if (matches(/composer/)) return "Cursor";
  if (matches(/(?:^|[-\s])grok/)) return "xAI";
  if (matches(/(?:^|[-\s])(?:gpt|codex|o\d)/)) return "OpenAI";
  if (matches(/claude|opus|fable|sonnet|haiku/)) return "Anthropic";
  if (matches(/gemini/)) return "Google";
  if (matches(/qwen/)) return "Alibaba";
  if (matches(/kimi|moonshot/)) return "Moonshot";
  if (matches(/glm|zhipu/)) return "Zhipu";
  if (matches(/deepseek/)) return "DeepSeek";
  return "";
}

/** The compact second line shared by every Cukii model picker option. */
export function formatCukiiModelSubtitle(
  contextWindowLabel: string,
  description: string,
): string {
  return `${contextWindowLabel} • ${description}`;
}

interface CukiiModelPresentation {
  value: string;
  label: string;
}
