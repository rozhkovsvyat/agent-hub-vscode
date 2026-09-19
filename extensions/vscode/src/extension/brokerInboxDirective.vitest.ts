import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));

import {
  brokerInboxDirective,
  brokerMemoryDirective,
  brokerUserQuestionDirective,
  supportsBrokerInbox,
} from "./bridgeChatAdapter";

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
      // A vendor that truncates the denial reason, or that reaches MCP only
      // through one generic invoker, must still be able to release the gate:
      // without both escapes Grok 4.6 spent a whole session denied.
      expect(lines[0]).toContain("opens with the exact ack IDs");
      expect(lines[0]).toContain("through a generic invoker");
      expect(lines[0]).toContain("replayOutstanding=true to recover it");
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

  it("tells Cursor that memory tools are MCP, not a missing builtin", () => {
    const lines = brokerMemoryDirective("cursor:grok-4.6");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cukii-memory MCP");
    expect(lines[0]).toContain("no built-in memory_search");
    expect(lines[0]).toContain("expected, not a broken harness");
    expect(brokerMemoryDirective("grok-4-6")).toEqual([]);
    expect(brokerMemoryDirective("composer-2-5")).toHaveLength(1);
  });

  it("offers the same request_user_input contract to every connected vendor", () => {
    for (const model of [
      "fable-5",
      "qwen-3-8-max",
      "codex-5-6-terra",
      "grok-4-6",
      "composer-2-5",
      "kimi-k2",
    ]) {
      const lines = brokerUserQuestionDirective(model);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("base name is request_user_input");
      expect(lines[0]).toContain("1–3 short questions");
    }
    expect(brokerUserQuestionDirective("deepseek-v4-pro")).toEqual([]);
  });
});
