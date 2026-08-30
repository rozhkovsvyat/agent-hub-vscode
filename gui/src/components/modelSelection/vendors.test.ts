import { describe, expect, it } from "vitest";

import {
  ALL_MODELS,
  applyRuntimeVendorCatalog,
  cukiiCapabilityRating,
  displayModelLabel,
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
      "kimi-k2": "K2.7 Coding",
      "kimi-k2-highspeed": "K2.7 Coding Highspeed",
      "kimi-k3": "K3",
      "kimi-k3-256k": "K3-256K",
      "deepseek-v4-pro": "V4 Pro",
      "qwen-3-8-max": "Qwen 3.8 Max",
    });
  });

  it("provides context and a concise description for every visible model", () => {
    for (const model of ALL_MODELS) {
      expect(model.contextWindowLabel, model.value).not.toBe("");
      expect(model.description.trim(), model.value).not.toBe("");
    }
  });

  it("uses one canonical vendor list in the picker", () => {
    expect(VENDORS.map((vendor) => vendor.label)).toEqual([
      "Anthropic",
      "OpenAI",
      "xAI",
      "Cursor",
      "Moonshot AI",
      "Alibaba Cloud",
      "DeepSeek",
    ]);
  });

  it("orders every vendor's model matrix by descending bottle rating with stable canonical ties", () => {
    const expectedModelOrderByVendor = {
      claude: ["fable-5", "opus-5", "sonnet-5", "haiku-4-5"],
      codex: [
        "codex-5-6-sol",
        "codex-5-6-terra",
        "codex-5-6-luna",
        "codex-5-5",
        "codex-5-4",
        "codex-5-4-mini",
      ],
      grok: ["grok-4-6", "grok-4-5"],
      cursor: ["composer-2-5"],
      kimi: ["kimi-k3", "kimi-k3-256k", "kimi-k2", "kimi-k2-highspeed"],
      qwen: ["qwen-3-8-max"],
      deepseek: ["deepseek-v4-pro"],
    } as const;

    for (const vendor of VENDORS) {
      const models = vendor.models;
      expect(models.map((model) => model.value), vendor.id).toEqual(
        expectedModelOrderByVendor[vendor.id],
      );
      expect(
        models.map(cukiiCapabilityRating),
        `${vendor.id} ratings`,
      ).toEqual(
        [...models.map(cukiiCapabilityRating)].sort((left, right) =>
          right - left,
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
    expect(isNonIncreasing(canonical as unknown as typeof presented), "unsorted mutation").toBe(
      false,
    );
  });

  it("formats every model subline with the exact bullet separator", () => {
    for (const model of ALL_MODELS) {
      const subtitle = formatCukiiModelSubtitle(
        model.contextWindowLabel,
        model.description,
      );
      expect(subtitle, model.value).toBe(
        `${model.contextWindowLabel} context • ${model.description}`,
      );
      expect(subtitle, model.value).not.toContain(
        `${model.contextWindowLabel} context — `,
      );
      expect(subtitle, model.value).not.toContain(
        `${model.contextWindowLabel} context - `,
      );
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

  it.each([
    ["fable-5", "irrelevant", 4],
    ["cursor:claude-fable-5", "Dynamic Cursor model", 4],
    ["opus-5", "Opus 5", 3],
    ["cursor:claude-opus-4-8", "Dynamic Cursor model", 3],
    ["codex-5-6-sol", "GPT-5.6 Sol", 3],
    ["cursor:gpt-5.6-sol", "Dynamic Cursor model", 3],
    ["kimi-k3-256k", "K3-256K", 3],
    ["qwen-3-8-max", "Qwen 3.8 Max", 3],
    ["sonnet-5", "Sonnet 5", 2],
    ["cursor:claude-4.6-sonnet", "Dynamic Cursor model", 2],
    ["codex-5-6-terra", "GPT-5.6 Terra", 2],
    ["cursor:cursor-grok-4.7", "Dynamic Cursor model", 2],
    ["codex-5-6-luna", "GPT-5.6 Luna", 1],
    ["cursor:gemini-3.7-flash", "Gemini 3.7 Flash", 1],
  ] as const)(
    "rates %s with its canonical capability tier",
    (value, label, expected) => {
      expect(cukiiCapabilityRating({ value, label })).toBe(expected);
    },
  );

  it("normalizes and sorts the live catalog without changing equal-tier order", () => {
    applyRuntimeVendorCatalog([
      {
        id: "codex",
        label: "OpenAI",
        models: [
          {
            value: "codex-5-6-luna",
            label: "GPT-5.6 Luna",
            contextWindowLabel: "272K",
            description: "   ",
          },
          {
            value: "codex-5-6-sol",
            label: "GPT-5.6 Sol",
            contextWindowLabel: "272K",
            description: "Live Sol description",
          },
          {
            value: "codex-5-6-terra",
            label: "GPT-5.6 Terra",
            contextWindowLabel: "272K",
            description: "Live Terra description",
          },
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
    expect(
      VENDORS.find((vendor) => vendor.id === "codex")?.models.map(
        (model) => model.value,
      ),
    ).toEqual([
      "codex-5-6-sol",
      "codex-5-6-terra",
      "codex-5-6-luna",
      "codex:custom",
    ]);
  });
});
