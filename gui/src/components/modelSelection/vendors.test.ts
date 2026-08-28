import { describe, expect, it } from "vitest";

import {
  ALL_MODELS,
  applyRuntimeVendorCatalog,
  cukiiCapabilityRating,
  displayModelLabel,
  supportsNativeThinking,
  VENDORS,
} from "./vendors";

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

  it("normalizes runtime catalog presentation to non-empty metadata", () => {
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
  });
});
