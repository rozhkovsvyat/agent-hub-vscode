import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));

import {
  brokerInboxDirective,
  supportsBrokerInbox,
} from "./bridgeChatAdapter";

describe("broker inbox steering gate", () => {
  it("covers every MCP-capable vendor; kimi and claude stay out", () => {
    expect(supportsBrokerInbox("qwen-3-8-max")).toBe(true);
    expect(supportsBrokerInbox("codex-5-6-terra")).toBe(true);
    expect(supportsBrokerInbox("grok-4-6")).toBe(true);
    expect(supportsBrokerInbox("composer-2-5")).toBe(true);
    // Kimi has no MCP surface; claude keeps the stronger native stdin push,
    // so the pull directive must not double-cover it.
    expect(supportsBrokerInbox("kimi-k2")).toBe(false);
    expect(supportsBrokerInbox("fable-5")).toBe(false);
  });

  it("emits the steering + inter-agent directive for wired vendors", () => {
    for (const model of [
      "qwen-3-8-max",
      "codex-5-6-terra",
      "grok-4-6",
      "composer-2-5",
    ] as const) {
      const lines = brokerInboxDirective(model);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("mcp__cukii-broker__broker_inbox");
      expect(lines[0]).toContain(
        "never call it more than once per step boundary",
      );
      // The strict gate is part of the contract the model is told about.
      expect(lines[0]).toContain("force-delivered");
      // Inter-agent channel rides the same rails.
      expect(lines[1]).toContain("mcp__cukii-broker__broker_send");
      expect(lines[1]).toContain("mcp__cukii-broker__broker_sessions");
      expect(lines[1]).toContain("never broker_send");
    }
  });

  it("stays silent for claude and kimi", () => {
    for (const model of ["fable-5", "kimi-k2"] as const) {
      expect(brokerInboxDirective(model)).toEqual([]);
    }
  });
});
