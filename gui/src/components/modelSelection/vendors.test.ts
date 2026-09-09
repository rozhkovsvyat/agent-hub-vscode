import { describe, expect, it } from "vitest";

import {
  ALL_MODELS,
  applyRuntimeVendorCatalog,
  BEST_MODELS,
  BROKER_MODEL_OPTIONS,
  cukiiCapabilityRating,
  displayModelLabel,
  effortLevelsForModel,
  isBestModel,
  normalizeEffortForModel,
  presentVendorModels,
  supportsNativeSpeed,
  supportsNativeThinking,
  VENDORS,
} from "./vendors";
import {
  canonicalCukiiModelLabel,
  cukiiModelUpstreamVendor,
  formatCukiiModelSubtitle,
} from "core/cukiiModelPresentation";

describe("Cukii model context labels", () => {
  it("keeps context out of the first-line display label", () => {
    expect(
      Object.fromEntries(
        ALL_MODELS.map((model) => [model.value, displayModelLabel(model)]),
      ),
    ).toEqual({
      "opus-5": "Opus 5",
      "sonnet-5": "Sonnet 5",
      "fable-5-1": "Fable 5.1",
      "fable-5": "Fable 5",
      "haiku-4-5": "Haiku 4.5",
      "codex:gpt-6-astra": "GPT-6 Astra",
      "codex-5-6-sol": "GPT-5.6 Sol",
      "codex-5-6-terra": "GPT-5.6 Terra",
      "codex-5-6-luna": "GPT-5.6 Luna",
      "codex-5-5": "GPT-5.5",
      "codex-5-4": "GPT-5.4",
      "codex-5-4-mini": "GPT-5.4 Mini",
      "grok-4-6": "Grok 4.6",
      "grok-4-5": "Grok 4.5",
      "cursor:grok-4.6": "Grok 4.6",
      "composer-2-5": "Composer 2.5",
      "kimi-k2": "Kimi K2.7 Coding",
      "kimi-k2-highspeed": "Kimi K2.7 Coding Highspeed",
      "kimi-k3": "Kimi K3",
      "kimi-k3-256k": "Kimi K3-256K",
      "deepseek-v4-pro": "V4 Pro",
      "qwen-3-8-max": "Qwen 3.8 Max",
      "qwen-3-8-flash": "Qwen 3.8 Flash",
      "qwen-3-7-plus": "Qwen 3.7 Plus",
      "qwen-3-7-max": "Qwen 3.7 Max",
      "qwen-3-6-flash": "Qwen 3.6 Flash",
      "qwen-deepseek-v4-pro-0813": "DeepSeek V4 Pro 0813",
      "qwen-deepseek-v4-pro": "DeepSeek V4 Pro",
      "qwen-deepseek-v4-flash-0731": "DeepSeek V4 Flash",
      "qwen-glm-5-2": "GLM 5.2",
    });
  });

  it("provides context and a concise description for every visible model", () => {
    for (const model of ALL_MODELS) {
      expect(model.contextWindowLabel, model.value).not.toBe("");
      expect(model.description.trim(), model.value).not.toBe("");
    }
  });

  it("uses the known Codex CLI route capacity as the static fallback", () => {
    for (const value of [
      "codex:gpt-6-astra",
      "codex-5-6-sol",
      "codex-5-6-terra",
      "codex-5-6-luna",
      "codex-5-5",
      "codex-5-4",
      "codex-5-4-mini",
    ]) {
      expect(
        ALL_MODELS.find((model) => model.value === value)?.contextWindowLabel,
        value,
      ).toBe("272K");
    }
  });

  it("uses one canonical vendor list in the picker", () => {
    expect(VENDORS.map((vendor) => vendor.label)).toEqual([
      "Alibaba",
      "Anthropic",
      "Cursor",
      "DeepSeek",
      "MoonshotAI",
      "OpenAI",
      "xAI",
    ]);
    expect(VENDORS[0]?.id).toBe("qwen");
    expect(ALL_MODELS[0]?.value).toBe("qwen-3-8-max");
    expect(BROKER_MODEL_OPTIONS[0]?.value).toBe("qwen-3-8-max");
  });

  it("keeps the curated Milky scope live and selectable", () => {
    expect(BEST_MODELS).toEqual([
      "qwen-3-8-max",
      "qwen-deepseek-v4-pro-0813",
      "fable-5-1",
      "opus-5",
      "codex:gpt-6-astra",
      "codex-5-6-sol",
      "codex-5-6-terra",
      "grok-4-6",
      "composer-2-5",
      "kimi-k3",
    ]);
    for (const value of BEST_MODELS) {
      const model = ALL_MODELS.find((entry) => entry.value === value);
      expect(model, value).toBeDefined();
      expect(model?.disabled, value).toBeFalsy();
      if (model) expect(isBestModel(model), value).toBe(true);
    }
    expect(isBestModel({ value: "haiku-4-5", label: "Haiku 4.5" })).toBe(false);
    expect(isBestModel({ value: "sonnet-5", label: "Sonnet 5" })).toBe(false);
  });

  it("does not put Alibaba image/audio/video capabilities in the chat picker", () => {
    const picker = new Set(ALL_MODELS.map((model) => model.value));
    for (const id of [
      "qwen-image-3.0-pro",
      "qwen-audio-3.0-asr-flash",
      "qwen-audio-3.0-tts-plus",
      "qwen-audio-3.0-realtime-plus",
      "wan2.7-image",
      "wan2.7-image-pro",
      "happyhorse-1.1-i2v",
      "happyhorse-1.1-t2v",
      "happyhorse-1.1-r2v",
    ]) {
      expect(picker.has(id), id).toBe(false);
    }
  });

  it("orders every vendor's model matrix by descending bottle rating with stable canonical ties", () => {
    const expectedModelOrderByVendor = {
      claude: ["fable-5-1", "opus-5", "sonnet-5", "fable-5", "haiku-4-5"],
      codex: [
        "codex:gpt-6-astra",
        "codex-5-6-sol",
        "codex-5-6-terra",
        "codex-5-6-luna",
        "codex-5-5",
        "codex-5-4",
        "codex-5-4-mini",
      ],
      grok: ["grok-4-6", "grok-4-5"],
      cursor: ["cursor:grok-4.6", "composer-2-5"],
      // K3-256K lost its bottles (it is a quota-saving sibling, not a Milky
      // route), so it falls in with the other unrated Kimi models and keeps
      // catalog order among them.
      kimi: ["kimi-k3", "kimi-k2", "kimi-k2-highspeed", "kimi-k3-256k"],
      qwen: [
        "qwen-3-8-max",
        "qwen-deepseek-v4-pro-0813",
        "qwen-3-8-flash",
        "qwen-3-7-plus",
        "qwen-3-7-max",
        "qwen-3-6-flash",
        "qwen-deepseek-v4-pro",
        "qwen-deepseek-v4-flash-0731",
        "qwen-glm-5-2",
      ],
      deepseek: ["deepseek-v4-pro"],
    } as const;

    for (const vendor of VENDORS) {
      const models = vendor.models;
      expect(
        models.map((model) => model.value),
        vendor.id,
      ).toEqual(expectedModelOrderByVendor[vendor.id]);
      expect(models.map(cukiiCapabilityRating), `${vendor.id} ratings`).toEqual(
        [...models.map(cukiiCapabilityRating)].sort(
          (left, right) => right - left,
        ),
      );
    }
  });

  it("rejects ascending and unsorted rating mutations while preserving equal-rating catalog order", () => {
    const canonical = [
      { value: "codex-5-4", label: "GPT-5.4", contextWindowLabel: "1M" },
      {
        value: "codex-5-6-terra",
        label: "GPT-5.6 Terra",
        contextWindowLabel: "1M",
      },
      {
        value: "codex-5-6-sol",
        label: "GPT-5.6 Sol",
        contextWindowLabel: "1M",
      },
      {
        value: "codex-5-5",
        label: "GPT-5.5",
        contextWindowLabel: "1M",
      },
    ] as const;
    const presented = presentVendorModels([...canonical]);
    const isNonIncreasing = (models: typeof presented) =>
      models.every(
        (model, index) =>
          index === 0 ||
          cukiiCapabilityRating(models[index - 1]) >=
            cukiiCapabilityRating(model),
      );

    expect(presented.map((model) => model.value)).toEqual([
      "codex-5-6-sol",
      "codex-5-6-terra",
      "codex-5-4",
      "codex-5-5",
    ]);
    expect(isNonIncreasing(presented)).toBe(true);
    expect(
      isNonIncreasing([...presented].reverse()),
      "ascending mutation",
    ).toBe(false);
    expect(
      isNonIncreasing(canonical as unknown as typeof presented),
      "unsorted mutation",
    ).toBe(false);
  });

  it("formats every model subline with the exact bullet separator", () => {
    for (const model of ALL_MODELS) {
      const subtitle = formatCukiiModelSubtitle(
        model.contextWindowLabel,
        model.description,
      );
      expect(subtitle, model.value).toBe(
        `${model.contextWindowLabel} • ${model.description}`,
      );
      expect(subtitle, model.value).not.toContain(
        `${model.contextWindowLabel} context — `,
      );
      expect(subtitle, model.value).not.toContain(
        `${model.contextWindowLabel} context - `,
      );
      expect(subtitle, model.value).not.toContain(
        `${model.contextWindowLabel} context • `,
      );
      expect(subtitle, model.value).not.toMatch(/\bcontext\b/i);
    }
  });

  it("exposes Thinking only for models with a verified native on/off switch", () => {
    expect(supportsNativeThinking("opus-5")).toBe(true);
    expect(supportsNativeThinking("sonnet-5")).toBe(true);
    expect(supportsNativeThinking("fable-5")).toBe(false);
    expect(supportsNativeThinking("codex-5-6-sol")).toBe(true);
    expect(supportsNativeThinking("grok-4-6")).toBe(false);
    expect(supportsNativeThinking("cursor:claude-opus-5")).toBe(true);
    expect(supportsNativeThinking("cursor:gpt-5.6-luna")).toBe(false);
  });

  it("exposes Anthropic Fast mode only for the verified Opus 5 route", () => {
    expect(supportsNativeSpeed("opus-5")).toBe(true);
    expect(supportsNativeSpeed("sonnet-5")).toBe(false);
    expect(supportsNativeSpeed("fable-5-1")).toBe(false);
    expect(supportsNativeSpeed("haiku-4-5")).toBe(false);
    expect(supportsNativeSpeed("codex:gpt-6-astra")).toBe(true);
  });

  it("renders only the effort levels supported by the selected route", () => {
    expect(effortLevelsForModel("codex-5-6-sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(effortLevelsForModel("codex:gpt-6-astra")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(effortLevelsForModel("codex-5-6-luna")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortLevelsForModel("fable-5-1")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effortLevelsForModel("grok-4-6")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(effortLevelsForModel("qwen-3-8-max")).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(normalizeEffortForModel("grok-4-6", "ultra")).toBe("xhigh");
    expect(normalizeEffortForModel("qwen-3-8-max", "max")).toBe("high");
  });

  it.each([
    ["codex:gpt-6-astra", "GPT-6 Astra", 3],
    ["fable-5-1", "Fable 5.1", 3],
    ["cursor:claude-fable-5-1", "Dynamic Cursor model", 3],
    ["codex-5-6-sol", "GPT-5.6 Sol", 2],
    ["cursor:gpt-5.6-sol", "Dynamic Cursor model", 2],
    ["qwen-3-8-max", "Qwen 3.8 Max", 3],
    ["opus-5", "Opus 5", 2],
    ["cursor:claude-opus-5", "Dynamic Cursor model", 2],
    ["kimi-k3", "Kimi K3", 2],
    // Superseded Opus generations Cursor still resells, and the quota-saving
    // Kimi sibling: present in the full catalog, never in Milky.
    ["cursor:claude-opus-4-8", "Dynamic Cursor model", 0],
    ["cursor:claude-opus-4-5", "Dynamic Cursor model", 0],
    ["kimi-k3-256k", "Kimi K3-256K", 0],
    ["codex-5-6-terra", "GPT-5.6 Terra", 1],
    ["grok-4-6", "Grok 4.6", 1],
    ["cursor:grok-4.6", "Dynamic Cursor model", 1],
    ["composer-2-5", "Composer 2.5", 1],
    ["qwen-deepseek-v4-pro-0813", "DeepSeek V4 Pro 0813", 1],
    ["fable-5", "Fable 5", 0],
    ["sonnet-5", "Sonnet 5", 0],
    ["cursor:claude-4.6-sonnet", "Dynamic Cursor model", 0],
    ["haiku-4-5", "Haiku 4.5", 0],
    ["codex-5-5", "GPT-5.5", 0],
    ["codex-5-4", "GPT-5.4", 0],
    ["codex-5-6-luna", "GPT-5.6 Luna", 0],
    ["grok-4-5", "Grok 4.5", 0],
    ["cursor:cursor-grok-4.7", "Dynamic Cursor model", 0],
    ["qwen-3-7-max", "Qwen 3.7 Max", 0],
    ["deepseek-v4-pro", "V4 Pro", 0],
    ["cursor:gemini-3.7-flash", "Gemini 3.7 Flash", 0],
  ] as const)(
    "rates %s with its curated Milky tier",
    (value, label, expected) => {
      expect(cukiiCapabilityRating({ value, label })).toBe(expected);
    },
  );

  it("keeps every non-top model at zero bottles", () => {
    expect(
      cukiiCapabilityRating({ value: "codex-5-5", label: "GPT-5.5" }),
    ).toBe(0);
    expect(
      cukiiCapabilityRating({ value: "sonnet-5", label: "Sonnet 5" }),
    ).toBe(0);
  });

  it("uses distinct Grok positioning and avoids tautological version tokens", () => {
    const modelsByValue = new Map(
      ALL_MODELS.map((model) => [model.value, model]),
    );
    const grokDescriptions = ["grok-4-6", "grok-4-5"].map(
      (value) => modelsByValue.get(value)?.description,
    );

    expect(new Set(grokDescriptions).size).toBe(grokDescriptions.length);
    expect(modelsByValue.get("grok-4-6")?.description).toBe(
      "Flagship xAI model for coding and agentic tasks",
    );
    expect(modelsByValue.get("grok-4-5")?.description).toBe(
      "Engineering-focused model for coding and agentic software workflows",
    );

    for (const [value, forbiddenToken] of [
      ["kimi-k2", "2.7"],
      ["kimi-k2-highspeed", "2.7"],
      ["kimi-k3", "k3"],
      ["kimi-k3-256k", "k3"],
    ] as const) {
      expect(
        modelsByValue.get(value)?.description.toLowerCase(),
        value,
      ).not.toContain(forbiddenToken);
    }
  });

  it("brands every live Kimi label without repeating the model name in its subtitle", () => {
    const kimiModels = presentVendorModels([
      { value: "kimi-k3", label: "K3", contextWindowLabel: "1M" },
      {
        value: "kimi:managed:kimi-code/k4",
        label: "K4 Preview",
        contextWindowLabel: "1M",
      },
    ]);

    expect(kimiModels.map((model) => model.label)).toEqual([
      "Kimi K3",
      "Kimi K4 Preview",
    ]);
    for (const model of kimiModels) {
      expect(model.description.toLowerCase()).not.toContain(
        model.label.toLowerCase(),
      );
    }
  });

  it("normalizes and sorts the live catalog without changing equal-tier order", () => {
    applyRuntimeVendorCatalog([
      {
        id: "codex",
        label: "OpenAI",
        models: [
          ...[
            ["codex-5-6-luna", "GPT-5.6 Luna", "   "],
            ["codex-5-6-sol", "GPT-5.6 Sol", "Live Sol description"],
            ["codex-5-6-terra", "GPT-5.6 Terra", "Live Terra description"],
            ["codex-5-5", "GPT-5.5", "Live GPT-5.5 description"],
            ["codex-5-4", "GPT-5.4", "Live GPT-5.4 description"],
          ].map(([value, label, description]) => ({
            value,
            label,
            contextWindowLabel: "272K",
            description,
          })),
          {
            value: "codex:custom",
            label: "Custom",
            contextWindowLabel: "   ",
            description: "Native description",
          },
        ],
      },
    ]);

    for (const model of VENDORS.flatMap((vendor) => vendor.models)) {
      expect(model.contextWindowLabel.trim(), model.value).not.toBe("");
      expect(model.description.trim(), model.value).not.toBe("");
    }
    expect(
      ALL_MODELS.find((model) => model.value === "codex-5-6-luna")?.description,
    ).toBe("Fast, affordable agentic coding model");
    expect(
      ALL_MODELS.find((model) => model.value === "codex:custom")
        ?.contextWindowLabel,
    ).toBe("Unavailable");
    for (const value of [
      "codex-5-6-sol",
      "codex-5-6-terra",
      "codex-5-6-luna",
      "codex-5-5",
      "codex-5-4",
    ]) {
      expect(
        ALL_MODELS.find((model) => model.value === value)?.contextWindowLabel,
        value,
      ).toBe("272K");
    }
    expect(
      VENDORS.find((vendor) => vendor.id === "codex")?.models.map(
        (model) => model.value,
      ),
    ).toEqual([
      "codex:gpt-6-astra",
      "codex-5-6-sol",
      "codex-5-6-terra",
      "codex-5-6-luna",
      "codex-5-5",
      "codex-5-4",
      "codex:custom",
    ]);
  });

  it("drops reseller and maker branding from a model name", () => {
    // Cursor answers "Claude Opus 5" and "Cursor Grok 4.6" for models the rest
    // of the picker calls "Opus 5" and "Grok 4.6". The section already names
    // the CLI, so the prefix only makes one model read two ways.
    expect(
      canonicalCukiiModelLabel("cursor:claude-opus-5", "Claude Opus 5"),
    ).toBe("Opus 5");
    expect(
      canonicalCukiiModelLabel("cursor:claude-fable-5-1", "Claude Fable 5.1"),
    ).toBe("Fable 5.1");
    expect(canonicalCukiiModelLabel("cursor:grok-4.6", "Cursor Grok 4.6")).toBe(
      "Grok 4.6",
    );
    // Names that merely contain the word keep it, and an already-clean name is
    // untouched — the rule is a prefix, not a search-and-replace.
    expect(canonicalCukiiModelLabel("opus-5", "Opus 5")).toBe("Opus 5");
    expect(canonicalCukiiModelLabel("composer-2-5", "Composer 2.5")).toBe(
      "Composer 2.5",
    );
  });

  it("orders the Cursor catalog by maker, then by bottles inside each maker", () => {
    applyRuntimeVendorCatalog([
      {
        id: "cursor",
        label: "Cursor",
        models: [
          ["cursor:grok-4.6", "Cursor Grok 4.6"],
          ["cursor:gpt-5.6-terra", "GPT-5.6 Terra"],
          ["cursor:claude-opus-4-8", "Claude Opus 4.8"],
          ["cursor:gemini-3.7-flash", "Gemini 3.7 Flash"],
          ["cursor:gpt-5.6-sol", "GPT-5.6 Sol"],
          ["composer-2-5", "Composer 2.5"],
          ["cursor:claude-fable-5-1", "Claude Fable 5.1"],
        ].map(([value, label]) => ({
          value,
          label,
          contextWindowLabel: "200K",
          description: "",
        })),
      },
    ]);

    // Anthropic, Cursor, Google, OpenAI, xAI — alphabetical by maker, with no
    // heading printed for any of them; Fable outranks Opus 4.8 on bottles and
    // Sol outranks Terra, both inside their own maker.
    expect(
      VENDORS.find((vendor) => vendor.id === "cursor")?.models.map(
        (model) => model.label,
      ),
    ).toEqual([
      "Fable 5.1",
      "Opus 4.8",
      "Composer 2.5",
      "Gemini 3.7 Flash",
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
      "Grok 4.6",
    ]);
  });

  it("NEGATIVE CONTROL: a maker key that stops discriminating breaks the order", () => {
    // Every assertion above is false if cukiiModelUpstreamVendor returns one
    // constant: the list would fall back to pure bottle order, which puts
    // Composer and Sol next to each other instead of under their makers.
    expect(
      cukiiModelUpstreamVendor({ value: "cursor:gpt-5.6-sol", label: "" }),
    ).toBe("OpenAI");
    expect(
      cukiiModelUpstreamVendor({
        value: "composer-2-5",
        label: "Composer 2.5",
      }),
    ).toBe("Cursor");
    expect(
      cukiiModelUpstreamVendor({ value: "cursor:claude-opus-5", label: "" }),
    ).toBe("Anthropic");
    expect(
      cukiiModelUpstreamVendor({ value: "cursor:grok-4.6", label: "" }),
    ).toBe("xAI");
    // An unknown maker must not collide with a known one, or it would sort
    // into the middle of the alphabet instead of after it.
    expect(cukiiModelUpstreamVendor({ value: "cursor:x1", label: "X1" })).toBe(
      "",
    );
  });
});
