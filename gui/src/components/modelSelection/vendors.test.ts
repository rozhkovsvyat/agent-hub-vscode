import { describe, expect, it } from "vitest";

import {
  ALL_MODELS,
  applyRuntimeVendorCatalog,
  BROKER_MODEL_OPTIONS,
  cukiiCapabilityRating,
  displayModelLabel,
  effortLevelsForModel,
  normalizeEffortForModel,
  presentVendorModels,
  supportsNativeThinking,
  VENDORS,
} from "./vendors";
import { formatCukiiModelSubtitle } from "core/cukiiModelPresentation";

describe("Cukii model context labels", () => {
  it("keeps context out of the first-line display label", () => {
    expect(
      Object.fromEntries(
        ALL_MODELS.map((model) => [model.value, displayModelLabel(model)]),
      ),
    ).toEqual({
      "opus-5": "Opus 5",
      "sonnet-5": "Sonnet 5",
      "fable-5": "Fable 5",
      "haiku-4-5": "Haiku 4.5",
      "codex-5-6-sol": "GPT-5.6 Sol",
      "codex-5-6-terra": "GPT-5.6 Terra",
      "codex-5-6-luna": "GPT-5.6 Luna",
      "codex-5-5": "GPT-5.5",
      "codex-5-4": "GPT-5.4",
      "codex-5-4-mini": "GPT-5.4 Mini",
      "grok-4-6": "Grok 4.6",
      "grok-4-5": "Grok 4.5",
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
      "OpenAI",
      "xAI",
      "Cursor",
      "Moonshot AI",
      "DeepSeek",
    ]);
    expect(VENDORS[0]?.id).toBe("qwen");
    expect(ALL_MODELS[0]?.value).toBe("qwen-3-8-max");
    expect(BROKER_MODEL_OPTIONS[0]?.value).toBe("qwen-3-8-max");
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
      claude: ["fable-5", "opus-5", "sonnet-5", "haiku-4-5"],
      codex: [
        "codex-5-6-sol",
        "codex-5-5",
        "codex-5-6-terra",
        "codex-5-4",
        "codex-5-6-luna",
        "codex-5-4-mini",
      ],
      grok: ["grok-4-6", "grok-4-5"],
      cursor: ["composer-2-5"],
      kimi: ["kimi-k3", "kimi-k3-256k", "kimi-k2", "kimi-k2-highspeed"],
      qwen: [
        "qwen-3-8-max",
        "qwen-3-7-max",
        "qwen-deepseek-v4-pro-0813",
        "qwen-deepseek-v4-pro",
        "qwen-3-7-plus",
        "qwen-glm-5-2",
        "qwen-3-8-flash",
        "qwen-3-6-flash",
        "qwen-deepseek-v4-flash-0731",
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
      "codex-5-5",
      "codex-5-4",
      "codex-5-6-terra",
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

  it("renders only the effort levels supported by the selected route", () => {
    expect(effortLevelsForModel("codex-5-6-sol")).toEqual([
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
    ["fable-5", "irrelevant", 4],
    ["cursor:claude-fable-5", "Dynamic Cursor model", 4],
    ["opus-5", "Opus 5", 3],
    ["cursor:claude-opus-4-8", "Dynamic Cursor model", 3],
    ["codex-5-6-sol", "GPT-5.6 Sol", 3],
    ["cursor:gpt-5.6-sol", "Dynamic Cursor model", 3],
    ["codex-5-5", "GPT-5.5", 3],
    ["kimi-k3-256k", "K3-256K", 3],
    ["qwen-3-8-max", "Qwen 3.8 Max", 3],
    ["sonnet-5", "Sonnet 5", 2],
    ["cursor:claude-4.6-sonnet", "Dynamic Cursor model", 2],
    ["codex-5-6-terra", "GPT-5.6 Terra", 2],
    ["codex-5-4", "GPT-5.4", 2],
    ["cursor:cursor-grok-4.7", "Dynamic Cursor model", 2],
    ["codex-5-6-luna", "GPT-5.6 Luna", 1],
    ["codex-5-4-mini", "GPT-5.4 Mini", 1],
    ["cursor:gemini-3.7-flash", "Gemini 3.7 Flash", 1],
  ] as const)(
    "rates %s with its canonical capability tier",
    (value, label, expected) => {
      expect(cukiiCapabilityRating({ value, label })).toBe(expected);
    },
  );

  it("keeps the requested GPT-5.5 and GPT-5.4 bottle tiers", () => {
    expect(
      cukiiCapabilityRating({ value: "codex-5-5", label: "GPT-5.5" }),
    ).toBe(3);
    expect(
      cukiiCapabilityRating({ value: "codex-5-4", label: "GPT-5.4" }),
    ).toBe(2);
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
      "Most capable frontier model for coding, agentic tasks, and knowledge work",
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
      "codex-5-6-sol",
      "codex-5-5",
      "codex-5-6-terra",
      "codex-5-4",
      "codex-5-6-luna",
      "codex:custom",
    ]);
  });
});
