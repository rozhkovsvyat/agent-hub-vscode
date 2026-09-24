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
  if (matches(/astra/)) return "Latest frontier agentic coding model";
  if (matches(/(?:gpt|codex).*sol/))
    return "Latest frontier agentic coding model";
  if (matches(/(?:gpt|codex).*terra/))
    return "Balanced agentic coding model for everyday work";
  if (matches(/(?:gpt|codex).*luna/))
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

const VENDOR_PREFIX = /^(?:cursor|codex|grok|kimi|claude|qwen):/i;
const BRANDING_ID_PREFIX = /^(?:cursor|claude)[-_\s]+/i;

export interface CukiiModelIdentity {
  family: string;
  version: number[];
  tier?: string;
  variant?: string;
}

/**
 * Bottle counts by family (and optional product tier). Versions never appear
 * here: a newer generation of the same family inherits the tier automatically.
 */
export const CUKII_FAMILY_TIER_RATING: Readonly<Record<string, 1 | 2 | 3>> = {
  "gpt:astra": 3,
  fable: 3,
  opus: 2,
  "qwen:max": 2,
  "gpt:sol": 2,
  kimi: 2,
  "gpt:luna": 1,
  grok: 1,
  composer: 1,
  "qwen-deepseek:pro": 1,
};

const DEFAULT_LATEST_GENERATION: ReadonlyArray<{
  family: string;
  tier?: string;
  version: readonly number[];
}> = [
  { family: "fable", version: [5, 1] },
  { family: "opus", version: [5, 5] },
  { family: "gpt", tier: "astra", version: [6] },
  { family: "gpt", tier: "sol", version: [6] },
  { family: "gpt", tier: "luna", version: [6] },
  { family: "grok", version: [4, 7] },
  { family: "composer", version: [2, 5] },
  { family: "kimi", version: [3] },
  { family: "qwen", tier: "max", version: [3, 8] },
  { family: "qwen-deepseek", tier: "pro", version: [4, 813] },
];

const latestGenerationByFamily: Array<{ key: string; version: number[] }> = [];

function familyKey(family: string, tier?: string): string {
  return tier ? `${family}:${tier}` : family;
}

function cloneVersion(version: readonly number[]): number[] {
  return [...version];
}

function seedLatestGeneration(): void {
  latestGenerationByFamily.splice(
    0,
    latestGenerationByFamily.length,
    ...DEFAULT_LATEST_GENERATION.map((row) => ({
      key: familyKey(row.family, row.tier),
      version: cloneVersion(row.version),
    })),
  );
}

seedLatestGeneration();

export function resetCukiiLatestGeneration(): void {
  seedLatestGeneration();
}

export function compareCukiiModelVersion(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function parseVersionParts(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(/[.\-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function detectVariant(id: string, text: string): string | undefined {
  if (/256k/.test(id) || /256k/.test(text)) return "256k";
  if (/build-fast/.test(id) || /build-fast/.test(text)) return "build-fast";
  if (/highspeed/.test(id) || /highspeed/.test(text)) return "highspeed";
  if (/(?:^|[\s-])thinking(?:[\s-]|$)/.test(id)) return "thinking";
  if (/(?:^|[\s.-])fast(?:[\s-]|$)/.test(id) && !/flash/.test(id)) return "fast";
  return undefined;
}

function stripIdentityNoise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(VENDOR_PREFIX, "")
    .replace(BRANDING_ID_PREFIX, "");
}

function stripVariantTokens(raw: string): string {
  return raw
    .replace(/build-fast/gi, " ")
    .replace(/highspeed/gi, " ")
    .replace(/256k/gi, " ")
    .replace(/(?:^|[\s.-])fast(?:[\s-]|$)/gi, " ")
    .replace(/(?:^|[\s-])thinking(?:[\s-]|$)/gi, " ");
}

/**
 * Collapse a vendor id + label into one family/version/tier identity so Cursor
 * resales and native CLIs rate the same route the same way.
 */
export function parseCukiiModelIdentity(
  model: Pick<CukiiModelPresentation, "value" | "label">,
): CukiiModelIdentity | undefined {
  const id = stripIdentityNoise(model.value);
  const label = model.label.trim().toLowerCase().replace(BRANDING_PREFIX, "");
  const variant = detectVariant(id, `${id} ${label}`);
  const text = stripVariantTokens(`${id} ${label}`);

  const identity = (partial: {
    family: string;
    version: number[];
    tier?: string;
  }): CukiiModelIdentity =>
    variant ? { ...partial, variant } : partial;

  const deepseek = text.match(
    /deepseek[-_\s]*v(\d+)(?:[-_\s]+(pro|flash))?(?:[-_\s]+(\d{4}))?/,
  );
  if (deepseek && /qwen/.test(text)) {
    const version = parseVersionParts(deepseek[1]);
    if (deepseek[3]) version.push(Number.parseInt(deepseek[3], 10));
    return identity({
      family: "qwen-deepseek",
      version,
      tier: deepseek[2] ?? "pro",
    });
  }

  if (/(?:^|[-\s:])glm(?:[-\s:]|$)/.test(text) || /qwen-glm/.test(id)) {
    const glmVersion = text.match(/glm[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "glm",
      version: parseVersionParts(glmVersion?.[1]),
    });
  }

  if (/(?:^|[-\s:])qwen(?:[-\s:]|$)/.test(text)) {
    const qwenVersion = text.match(/qwen[\s._-]*(\d+(?:[.\-]\d+)*)/);
    const tierMatch = text.match(/\b(max|flash|plus)\b/);
    return identity({
      family: "qwen",
      version: parseVersionParts(qwenVersion?.[1]),
      tier: tierMatch?.[1],
    });
  }

  if (
    /kimi/.test(text) ||
    /(?:^|[\s/_-])k\d/.test(id) ||
    /(?:^|[\s/_-])k\d/.test(text)
  ) {
    const kimiVersion =
      text.match(/(?:kimi[\s._-]*k|\/k)(\d+(?:[.\-]\d+)*)/) ??
      text.match(/(?:^|[\s/_-])k(\d+(?:[.\-]\d+)*)/);
    let version = parseVersionParts(kimiVersion?.[1]);
    if (version.length === 1 && version[0] === 2) version = [2, 7];
    return identity({ family: "kimi", version });
  }

  if (/composer/.test(text)) {
    const composerVersion = text.match(/composer[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "composer",
      version: parseVersionParts(composerVersion?.[1]),
    });
  }

  if (/(?:^|[-\s:])grok(?:[-\s:]|$)/.test(text)) {
    const grokVersion = text.match(/grok[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "grok",
      version: parseVersionParts(grokVersion?.[1]),
    });
  }

  if (/(?:^|[-\s:])fable(?:[-\s:]|$)/.test(text)) {
    const fableVersion = text.match(/fable[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "fable",
      version: parseVersionParts(fableVersion?.[1]),
    });
  }

  if (/(?:^|[-\s:])opus(?:[-\s:]|$)/.test(text)) {
    const opusVersion = text.match(/opus[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "opus",
      version: parseVersionParts(opusVersion?.[1]),
    });
  }

  if (/(?:^|[-\s:])sonnet(?:[-\s:]|$)/.test(text)) {
    const sonnetVersion = text.match(/sonnet[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "sonnet",
      version: parseVersionParts(sonnetVersion?.[1]),
    });
  }

  if (/(?:^|[-\s:])haiku(?:[-\s:]|$)/.test(text)) {
    const haikuVersion = text.match(/haiku[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "haiku",
      version: parseVersionParts(haikuVersion?.[1]),
    });
  }

  if (/(?:^|[-\s:])(?:gpt|codex)(?:[-\s:]|$)/.test(text) || /gpt/.test(id)) {
    const gptVersion = text.match(/(?:gpt|codex)[\s._-]*(\d+(?:[.\-]\d+)*)/);
    const tierMatch = text.match(/\b(astra|sol|luna|terra|mini|nano)\b/);
    return identity({
      family: "gpt",
      version: parseVersionParts(gptVersion?.[1]),
      tier: tierMatch?.[1],
    });
  }

  if (/gemini/.test(text)) {
    const geminiVersion = text.match(/gemini[\s._-]*(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "gemini",
      version: parseVersionParts(geminiVersion?.[1]),
    });
  }

  if (/deepseek/.test(text)) {
    const dsVersion = text.match(/deepseek[\s._-]*v?(\d+(?:[.\-]\d+)*)/);
    return identity({
      family: "deepseek",
      version: parseVersionParts(dsVersion?.[1]),
    });
  }

  return undefined;
}

function latestVersionFor(key: string): number[] | undefined {
  return latestGenerationByFamily.find((row) => row.key === key)?.version;
}

/**
 * Replace the latest-generation registry with the max version of each
 * family+tier seen in the catalogs the picker actually received.
 */
export function observeCukiiLatestGeneration(
  models: Array<Pick<CukiiModelPresentation, "value" | "label">>,
): void {
  const max = new Map<string, number[]>();
  for (const model of models) {
    const parsed = parseCukiiModelIdentity(model);
    if (!parsed || parsed.version.length === 0) continue;
    const key = familyKey(parsed.family, parsed.tier);
    const current = max.get(key);
    if (!current || compareCukiiModelVersion(parsed.version, current) > 0) {
      max.set(key, cloneVersion(parsed.version));
    }
  }
  latestGenerationByFamily.splice(
    0,
    latestGenerationByFamily.length,
    ...[...max.entries()].map(([key, version]) => ({ key, version })),
  );
}

/**
 * Product-level capability tier shown as Cukii bottles in the model picker.
 * Only the curated top group ("Milky") carries bottles, and only the latest
 * known generation of that family. Every other model rates 0.
 */
export function cukiiCapabilityRating(
  model: Pick<CukiiModelPresentation, "value" | "label">,
): 0 | 1 | 2 | 3 {
  const parsed = parseCukiiModelIdentity(model);
  if (!parsed) return 0;
  if (parsed.variant === "256k") return 0;
  const key = familyKey(parsed.family, parsed.tier);
  const tierRating = CUKII_FAMILY_TIER_RATING[key];
  if (!tierRating) return 0;
  const latest = latestVersionFor(key);
  if (!latest) return 0;
  if (compareCukiiModelVersion(parsed.version, latest) !== 0) return 0;
  return tierRating;
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
