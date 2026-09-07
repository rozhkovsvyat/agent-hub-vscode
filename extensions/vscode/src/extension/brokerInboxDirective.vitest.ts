import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));

import { brokerInboxDirective, supportsBrokerInbox } from "./bridgeChatAdapter";

describe("broker inbox steering gate", () => {
  it("covers every MCP-capable vendor; claude stays out", () => {
    expect(supportsBrokerInbox("qwen-3-8-max")).toBe(true);
    expect(supportsBrokerInbox("codex-5-6-terra")).toBe(true);
    expect(supportsBrokerInbox("grok-4-6")).toBe(true);
    expect(supportsBrokerInbox("composer-2-5")).toBe(true);
    expect(supportsBrokerInbox("kimi-k2")).toBe(true);
    // Claude keeps the stronger native stdin push, so the pull directive
    // must not double-cover it.
    expect(supportsBrokerInbox("fable-5")).toBe(false);
  });

  it("emits the steering + inter-agent directive for wired vendors", () => {
    for (const model of [
      "qwen-3-8-max",
      "codex-5-6-terra",
      "grok-4-6",
      "composer-2-5",
      "kimi-k2",
    ] as const) {
      const lines = brokerInboxDirective(model);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("base name is broker_inbox");
      expect(lines[0]).toContain("cukii-broker or agent-hub-broker");
      expect(lines[0]).toContain("broker_inbox_ack");
      expect(lines[0]).toContain(
        "If you fail before ack, the batch must be delivered again",
      );
      expect(lines[0]).toContain(
        "never call it more than once per step boundary",
      );
      // The strict gate is part of the contract the model is told about.
      expect(lines[0]).toContain("force-delivered");
      expect(lines[0]).toContain("A normal follow-up must never stop the run");
      expect(lines[0]).toContain(
        "only an explicit stop/cancel request ends the run",
      );
      // Inter-agent channel rides the same rails.
      expect(lines[1]).toContain("broker_send");
      expect(lines[1]).toContain("broker_sessions");
      expect(lines[1]).toContain("never broker_send");
    }
  });

  it("stays silent for claude", () => {
    expect(brokerInboxDirective("fable-5")).toEqual([]);
  });
});
