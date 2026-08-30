import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));
vi.mock("./permissionCapabilities", () => ({
  cachedVendorPermissionCapabilities: (vendor: string) => ({
    vendor,
    supportedModes:
      vendor === "codex"
        ? ["bypass"]
        : vendor === "deepseek"
          ? []
          : ["plan", "bypass"],
    helpSource: "test-route",
  }),
}));

import {
  attachClaudePermissionTransport,
  isInternalSteerRead,
  nativeDelegateHint,
  routeForModel,
} from "./bridgeChatAdapter";
import { ClaudePermissionBroker } from "./claudePermissionBroker";
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
  it("keeps bridge transcript files in Scratch and suppresses only the exact steering read", () => {
    const prompt = "x".repeat(25_000);
    const route = routeForModel(
      "kimi-k3",
      "D:/Brain/vault",
      prompt,
      [],
      resolveBridgeControls("kimi-k3", "high", "standard"),
    );
    expect(route.promptFile?.toLowerCase()).toContain(
      "d:\\scratch\\cukii-bridge",
    );
    expect(route.args).toContain("D:\\Scratch\\cukii-bridge");
    if (route.promptFile) promptFiles.push(route.promptFile);

    const steerPath = "D:\\Scratch\\cukii-steer\\cukii-steer-test.txt";
    expect(
      isInternalSteerRead(
        {
          kind: "toolStart",
          id: "internal-read",
          name: "Read",
          args: JSON.stringify({ file_path: steerPath }),
        },
        steerPath,
      ),
    ).toBe(true);
    expect(
      isInternalSteerRead(
        {
          kind: "toolStart",
          id: "ordinary-read",
          name: "Read",
          args: JSON.stringify({ file_path: "D:\\Brain\\vault\\README.md" }),
        },
        steerPath,
      ),
    ).toBe(false);
  });

  it("adds the real Claude MCP permission transport without leaking its token", async () => {
    const route = routeForModel(
      "opus-5",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("opus-5", "high", "standard"),
      "manual",
    );
    const broker = new ClaudePermissionBroker({
      panelId: "panel-a",
      sessionId: "session-a",
      mode: "manual",
      onRequest: () => {},
    });
    await broker.start();
    try {
      attachClaudePermissionTransport(route, broker);
      expect(route.args.slice(-7)).toEqual([
        "--mcp-config",
        broker.configPath,
        "--strict-mcp-config",
        "--allowed-tools",
        "mcp__cukii_permission__request",
        "--permission-prompt-tool",
        "mcp__cukii_permission__request",
      ]);
      expect(route.args.join(" ")).not.toContain(broker.token);
    } finally {
      await broker.dispose();
    }
  });

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
      "--permission-mode",
      "manual",
      "-p",
      "--input-format",
      "stream-json",
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
        "bypass",
      );
      expect(route.args.slice(0, 9)).toEqual([
        "-m",
        model === "codex-5-6-terra" ? "gpt-5.6-terra" : "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="medium"',
        "-c",
        'service_tier="priority"',
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
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
      "bypass",
    );
    expect(route.args).toContain('model_reasoning_effort="none"');
    expect(route.args).toContain('service_tier="priority"');
  });

  it("routes only verified noninteractive modes to non-conflicting flag sets", () => {
    const cases = [
      [
        "opus-5",
        "plan",
        "--permission-mode plan",
        "--dangerously-skip-permissions",
      ],
      [
        "opus-5",
        "bypass",
        "--dangerously-skip-permissions",
        "--permission-mode",
      ],
      [
        "codex-5-6-terra",
        "bypass",
        "--dangerously-bypass-approvals-and-sandbox",
        "--approve-for-me",
      ],
      ["grok-4-6", "plan", "--permission-mode plan", "--always-approve"],
      ["composer-2-5", "plan", "--plan", "--trust"],
      ["kimi-k3", "bypass", "--auto", "--yolo"],
      [
        "qwen-3-8-max",
        "bypass",
        "--approval-mode yolo",
        "--approval-mode plan",
      ],
    ] as const;

    for (const [model, mode, required, forbidden] of cases) {
      const route = routeForModel(
        model,
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls(model, "high", "standard"),
        mode,
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args.join(" ")).toContain(required);
      expect(route.args.join(" ")).not.toContain(forbidden);
    }
  });

  it("keeps nested delegate hints on the selected, verified permission route", () => {
    const codexBypass = nativeDelegateHint(
      "codex-5-6-terra",
      "D:/Brain/vault",
      "bypass",
    );
    expect(codexBypass).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexBypass).not.toContain("danger-full-access");

    const qwenPlan = nativeDelegateHint(
      "qwen-3-8-max",
      "D:/Brain/vault",
      "plan",
    );
    expect(qwenPlan).toContain("--approval-mode plan");
    expect(qwenPlan).not.toContain("--approval-mode yolo");

    expect(() =>
      nativeDelegateHint("codex-5-6-terra", "D:/Brain/vault", "manual"),
    ).toThrow("no verified permission mode");
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
