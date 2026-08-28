import { describe, expect, it } from "vitest";

import {
  codexCatalogFromCache,
  cursorCatalogFromOutput,
  grokCatalogFromOutput,
  kimiCatalogFromJson,
  resolveCursorCatalogModel,
  staticCatalogForUnavailableDiscovery,
} from "./bridgeModelCatalog";

describe("Cukii live subscription model catalog", () => {
  it("keeps every visible Codex subscription model", () => {
    const models = codexCatalogFromCache(
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.6-luna",
            display_name: "GPT-5.6-Luna",
            description: "Native Codex description",
            context_window: 272000,
            visibility: "list",
          },
          {
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6-Terra",
            description: "   ",
            context_window: 0,
            visibility: "list",
          },
          { slug: "hidden", display_name: "Hidden", visibility: "hide" },
        ],
      }),
    );
    expect(models).toEqual([
      {
        value: "codex-5-6-luna",
        label: "GPT-5.6 Luna",
        contextWindowLabel: "272K",
        description: "Native Codex description",
      },
      {
        value: "codex-5-6-terra",
        label: "GPT-5.6 Terra",
        contextWindowLabel: "1M",
        description: "Balanced agentic coding model for everyday work",
      },
    ]);
  });

  it("parses every model returned by xAI", () => {
    expect(
      grokCatalogFromOutput(
        "  * grok-4.6 (default)\n  - grok-4.5\n  - grok-4.7\n",
      ),
    ).toEqual([
      {
        value: "grok-4-6",
        label: "Grok 4.6",
        contextWindowLabel: "500K",
        description: "xAI model for coding and agentic tasks",
      },
      {
        value: "grok-4-5",
        label: "Grok 4.5",
        contextWindowLabel: "500K",
        description: "xAI model for coding and agentic tasks",
      },
      {
        value: "grok:grok-4.7",
        label: "Grok 4.7",
        contextWindowLabel: "500K",
        description: "xAI model for coding and agentic tasks",
      },
    ]);
  });

  it("uses the complete managed Moonshot model map and its real contexts", () => {
    const models = kimiCatalogFromJson(
      JSON.stringify({
        models: {
          "kimi-code/k3": {
            provider: "managed:kimi-code",
            displayName: "K3",
            maxContextSize: 1048576,
          },
          "kimi-code/k3-256k": {
            provider: "managed:kimi-code",
            displayName: "K3-256k",
            maxContextSize: 262144,
          },
        },
      }),
    );
    expect(
      models.map((model) => [model.value, model.contextWindowLabel]),
    ).toEqual([
      ["kimi-k3", "1M"],
      ["kimi-k3-256k", "256K"],
    ]);
    expect(models.every((model) => Boolean(model.description))).toBe(true);
  });

  it("deduplicates Cursor effort/speed variants into subscription models", async () => {
    const models = cursorCatalogFromOutput(
      [
        "Available models",
        "auto - Auto (default)",
        "claude-opus-5-thinking-high - Claude Opus 5 1M Thinking",
        "claude-opus-5-thinking-high-fast - Claude Opus 5 Thinking Fast",
        "claude-opus-5-low - Claude Opus 5 1M Low",
        "composer-2.5 - Composer 2.5 (current)",
        "composer-2.5-fast - Composer 2.5 Fast",
        "claude-4.6-sonnet-medium - Claude Sonnet 4.6 1M",
        "claude-4.6-sonnet-medium-thinking - Claude Sonnet 4.6 1M Thinking",
        "glm-5.2-high - GLM 5.2",
      ].join("\n"),
    );
    expect(models).toEqual([
      {
        value: "cursor:claude-opus-5",
        label: "Claude Opus 5",
        contextWindowLabel: "1M",
        description: "Best for everyday, complex tasks",
      },
      {
        value: "composer-2-5",
        label: "Composer 2.5",
        contextWindowLabel: "200K",
        description: "Fast agentic model for long-running coding tasks",
      },
      {
        value: "cursor:claude-4.6-sonnet",
        label: "Claude Sonnet 4.6",
        contextWindowLabel: "1M",
        description: "Efficient for routine development tasks",
      },
      {
        value: "cursor:glm-5.2",
        label: "GLM 5.2",
        contextWindowLabel: "200K",
        description: "GLM model available through Cursor",
      },
    ]);
    expect(
      resolveCursorCatalogModel("cursor:claude-opus-5", "high", "fast", true),
    ).toBe("claude-opus-5-thinking-high-fast");
    expect(
      models.every((model) => model.contextWindowLabel !== "Unknown"),
    ).toBe(true);
  });

  it("does not invent dynamic vendor models after live discovery fails", () => {
    expect(staticCatalogForUnavailableDiscovery("codex")).toEqual([]);
    expect(staticCatalogForUnavailableDiscovery("grok")).toEqual([]);
    expect(staticCatalogForUnavailableDiscovery("cursor")).toEqual([]);
    expect(staticCatalogForUnavailableDiscovery("kimi")).toEqual([]);
    expect(staticCatalogForUnavailableDiscovery("deepseek")).toEqual([]);
    expect(staticCatalogForUnavailableDiscovery("claude")).toContainEqual(
      expect.objectContaining({ value: "haiku-4-5" }),
    );
    expect(staticCatalogForUnavailableDiscovery("qwen")).toContainEqual(
      expect.objectContaining({ value: "qwen-3-8-max" }),
    );
  });
});
