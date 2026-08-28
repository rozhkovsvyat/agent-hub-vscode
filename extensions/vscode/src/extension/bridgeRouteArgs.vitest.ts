import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));

import { routeForModel } from "./bridgeChatAdapter";
import { resolveBridgeControls } from "./bridgeControls";
import {
  cursorCatalogFromOutput,
  grokCatalogFromOutput,
} from "./bridgeModelCatalog";

const promptFiles: string[] = [];
afterEach(() => {
  for (const file of promptFiles.splice(0)) fs.rmSync(file, { force: true });
});

describe("native bridge argv", () => {
  it("wires independent Claude effort and speed into the native CLI", () => {
    const controls = resolveBridgeControls("opus-5", "xhigh", "fast");
    const route = routeForModel(
      "opus-5",
      "D:/Brain/vault",
      "prompt",
      [],
      controls,
    );
    expect(route.args).toEqual([
      "--model",
      "claude-opus-5",
      "--effort",
      "xhigh",
      "--settings",
      '{"fastMode":true,"alwaysThinkingEnabled":true}',
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it.each(["codex-5-6-terra", "codex-5-6-sol"] as const)(
    "wires Codex %s effort and priority tier before exec",
    (model) => {
      const route = routeForModel(
        model,
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls(model, "medium", "fast"),
      );
      expect(route.args.slice(0, 8)).toEqual([
        "-m",
        model === "codex-5-6-terra" ? "gpt-5.6-terra" : "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="medium"',
        "-c",
        'service_tier="priority"',
        "exec",
        "--json",
      ]);
    },
  );

  it("disables Codex reasoning through the real native none value", () => {
    const route = routeForModel(
      "codex-5-6-terra",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("codex-5-6-terra", "medium", "fast", false),
    );
    expect(route.args).toContain('model_reasoning_effort="none"');
    expect(route.args).toContain('service_tier="priority"');
  });

  it("wires Grok reasoning effort and reports no fake fast tier", () => {
    const controls = resolveBridgeControls("grok-4-6", "max", "fast");
    const route = routeForModel(
      "grok-4-6",
      "D:/Brain/vault",
      "prompt",
      [],
      controls,
    );
    if (route.promptFile) promptFiles.push(route.promptFile);
    expect(route.args).toContain("--reasoning-effort");
    expect(route.args[route.args.indexOf("--reasoning-effort") + 1]).toBe(
      "xhigh",
    );
    expect(controls.effectiveSpeed).toBe("standard");
  });

  it("routes a newly discovered xAI model with its exact native id", () => {
    const [catalogModel] = grokCatalogFromOutput("  - grok-4.7\n");
    expect(catalogModel.value).toBe("grok:grok-4.7");
    const route = routeForModel(
      catalogModel.value,
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls(catalogModel.value, "high", "standard"),
    );
    if (route.promptFile) promptFiles.push(route.promptFile);
    expect(route.args[route.args.indexOf("--model") + 1]).toBe("grok-4.7");
  });

  it("switches Cursor to its real Fast model id", () => {
    const route = routeForModel(
      "composer-2-5",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("composer-2-5", "high", "fast"),
    );
    expect(route.args.join(" ")).toContain("composer-2.5-fast");
  });

  it("routes a live Cursor subscription family through its matching native variant", () => {
    cursorCatalogFromOutput(
      "gpt-5.6-luna-high - GPT-5.6 Luna 1M High\n" +
        "gpt-5.6-luna-high-fast - GPT-5.6 Luna High Fast\n",
    );
    const model = "cursor:gpt-5.6-luna";
    const route = routeForModel(
      model,
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls(model, "high", "fast"),
    );
    expect(route.args.join(" ")).toContain("gpt-5.6-luna-high-fast");
  });

  it("routes a dynamically discovered Moonshot subscription alias unchanged", () => {
    const route = routeForModel(
      "kimi:managed:kimi-code/k4",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("kimi:managed:kimi-code/k4", "high", "standard"),
    );
    expect(route.args).toContain("-m");
    expect(route.args[route.args.indexOf("-m") + 1]).toBe(
      "managed:kimi-code/k4",
    );
  });

  it("pins legacy K2 to the exact managed subscription model", () => {
    const route = routeForModel(
      "kimi-k2",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("kimi-k2", "high", "standard"),
    );
    expect(route.args).toContain("-m");
    expect(route.args[route.args.indexOf("-m") + 1]).toBe(
      "kimi-code/kimi-for-coding",
    );
  });

  it.each(["kimi-k2", "kimi-k3", "qwen-3-8-max"] as const)(
    "keeps %s on standard speed instead of silently inventing a vendor flag",
    (model) => {
      const controls = resolveBridgeControls(model, "high", "fast");
      expect(controls.speedTransport).toBe("unavailable");
      expect(controls.effectiveSpeed).toBe("standard");
      const route = routeForModel(
        model,
        "D:/Brain/vault",
        "prompt",
        [],
        controls,
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args.join(" ")).not.toMatch(
        /service_tier|fastMode|\bfast\b/,
      );
    },
  );

  it("keeps the existing DeepSeek transport failure explicit", () => {
    expect(() =>
      routeForModel(
        "deepseek-v4-pro",
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("deepseek-v4-pro", "high", "fast"),
      ),
    ).toThrow("DeepSeek bridge is not connected yet");
  });
});
