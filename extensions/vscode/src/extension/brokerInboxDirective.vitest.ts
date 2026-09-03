import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));

import {
  brokerInboxDirective,
  supportsBrokerInbox,
} from "./bridgeChatAdapter";

describe("broker inbox steering gate", () => {
  it("is enabled only for qwen-routed broker models in R1", () => {
    expect(supportsBrokerInbox("qwen-3-8-max")).toBe(true);
    expect(supportsBrokerInbox("codex-5-6-terra")).toBe(false);
    expect(supportsBrokerInbox("grok-4-6")).toBe(false);
    expect(supportsBrokerInbox("composer-2-5")).toBe(false);
    expect(supportsBrokerInbox("kimi-k2")).toBe(false);
    // Claude keeps its native stdin push; the pull directive must not
    // double-cover it even though its transport would accept the tool.
    expect(supportsBrokerInbox("fable-5")).toBe(false);
  });

  it("emits the pull directive for qwen and nobody else", () => {
    const qwen = brokerInboxDirective("qwen-3-8-max");
    expect(qwen).toHaveLength(1);
    expect(qwen[0]).toContain("mcp__cukii-broker__broker_inbox");
    expect(qwen[0]).toContain("never call it more than once per step boundary");

    for (const model of [
      "fable-5",
      "codex-5-6-terra",
      "grok-4-6",
      "composer-2-5",
      "kimi-k2",
    ] as const) {
      expect(brokerInboxDirective(model)).toEqual([]);
    }
  });
});
