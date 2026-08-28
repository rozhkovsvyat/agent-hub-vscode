import { describe, expect, it } from "vitest";

import {
  bridgeControlPrompt,
  bridgeControlSummary,
  claudeControlArgs,
  codexControlArgs,
  cursorModelId,
  grokControlArgs,
  resolveBridgeControls,
} from "./bridgeControls";

describe("Cukii bridge controls", () => {
  it.each(["opus-5", "codex-5-6-terra", "codex-5-6-sol"] as const)(
    "passes medium effort and fast speed natively for %s",
    (model) => {
      expect(resolveBridgeControls(model, "medium", "fast")).toMatchObject({
        nativeEffort: "medium",
        effortTransport: "native",
        effectiveSpeed: "fast",
        speedTransport: "native",
        effectiveThinking: true,
        thinkingTransport: "native",
      });
    },
  );

  it("clamps Claude Ultra to Max while retaining the Ultra broker contract", () => {
    const controls = resolveBridgeControls("opus-5", "ultra", "standard");
    expect(controls.nativeEffort).toBe("max");
    expect(controls.effortTransport).toBe("native-clamped");
    expect(bridgeControlPrompt(controls).join(" ")).toContain("decomposition");
  });

  it("builds the exact Claude, Codex, Grok and Cursor native switches", () => {
    const claude = resolveBridgeControls("opus-5", "xhigh", "fast");
    expect(claudeControlArgs(claude)).toEqual([
      "--effort",
      "xhigh",
      "--settings",
      '{"fastMode":true,"alwaysThinkingEnabled":true}',
    ]);

    const codex = resolveBridgeControls("codex-5-6-terra", "medium", "fast");
    expect(codexControlArgs(codex)).toEqual([
      "-c",
      'model_reasoning_effort="medium"',
      "-c",
      'service_tier="priority"',
    ]);

    const grok = resolveBridgeControls("grok-4-6", "high", "standard");
    expect(grokControlArgs(grok)).toEqual(["--reasoning-effort", "high"]);

    expect(
      cursorModelId(resolveBridgeControls("composer-2-5", "high", "fast")),
    ).toBe("composer-2.5-fast");
  });

  it("uses Claude's native alwaysThinkingEnabled switch", () => {
    const controls = resolveBridgeControls("opus-5", "high", "standard", false);
    expect(controls).toMatchObject({
      requestedThinking: false,
      effectiveThinking: false,
      thinkingTransport: "native",
    });
    expect(claudeControlArgs(controls)).toContain(
      '{"fastMode":false,"alwaysThinkingEnabled":false}',
    );
  });

  it("keeps Opus 5 disabled-thinking argv valid while preserving the requested effort", () => {
    const controls = resolveBridgeControls("opus-5", "ultra", "standard", false);
    expect(controls).toMatchObject({
      requestedEffort: "ultra",
      nativeEffort: "high",
      effortTransport: "native-clamped",
      effectiveThinking: false,
    });
    expect(claudeControlArgs(controls)).toEqual([
      "--effort",
      "high",
      "--settings",
      '{"fastMode":false,"alwaysThinkingEnabled":false}',
    ]);
    expect(bridgeControlSummary(controls)).toContain(
      "ultra (saved; inactive while Thinking is off)",
    );
  });

  it("does not expose or send a Thinking switch for Fable 5", () => {
    const controls = resolveBridgeControls("fable-5", "high", "standard", false);
    expect(controls).toMatchObject({
      requestedThinking: false,
      effectiveThinking: true,
      thinkingTransport: "unavailable",
    });
    expect(claudeControlArgs(controls)).toEqual([
      "--effort",
      "high",
      "--settings",
      '{"fastMode":false}',
    ]);
  });

  it("maps disabled Codex Thinking to the native none reasoning effort", () => {
    const controls = resolveBridgeControls(
      "codex-5-6-terra",
      "medium",
      "fast",
      false,
    );
    expect(codexControlArgs(controls)).toContain(
      'model_reasoning_effort="none"',
    );
    expect(controls.effectiveThinking).toBe(false);
    expect(bridgeControlPrompt(controls).join(" ")).toContain(
      "saved but inactive",
    );
    expect(bridgeControlSummary(controls)).toContain(
      "saved; inactive while Thinking is off",
    );
  });

  it("does not pretend to disable Thinking for vendors without a native switch", () => {
    expect(
      resolveBridgeControls("grok-4-6", "high", "standard", false),
    ).toMatchObject({
      requestedThinking: false,
      effectiveThinking: true,
      thinkingTransport: "unavailable",
    });
  });

  it("uses Grok's native reasoning knob and clamps unsupported Max", () => {
    expect(resolveBridgeControls("grok-4-6", "max", "fast")).toMatchObject({
      nativeEffort: "xhigh",
      effortTransport: "native-clamped",
      effectiveSpeed: "standard",
      speedTransport: "unavailable",
    });
  });

  it.each(["composer-2-5", "kimi-k3", "qwen-3-8-max"] as const)(
    "never silently claims native effort for %s",
    (model) => {
      const controls = resolveBridgeControls(model, "high", "fast");
      expect(controls.nativeEffort).toBeUndefined();
      expect(controls.effortTransport).toBe("broker-contract");
      if (model !== "composer-2-5") {
        expect(controls.speedTransport).toBe("unavailable");
        expect(controls.effectiveSpeed).toBe("standard");
      }
    },
  );

  it.each(["sonnet-5", "fable-5"] as const)(
    "does not claim Claude Fast for %s without a verified native tier",
    (model) => {
      expect(resolveBridgeControls(model, "high", "fast")).toMatchObject({
        effectiveSpeed: "standard",
        speedTransport: "unavailable",
      });
    },
  );
});
