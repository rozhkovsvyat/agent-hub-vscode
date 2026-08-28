import { ModelDescription, Tool } from "core";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_CHAT_SYSTEM_MESSAGE,
  DEFAULT_PLAN_SYSTEM_MESSAGE,
} from "core/llm/defaultSystemMessages";

export const NO_TOOL_WARNING =
  "\n\nTHE USER HAS NOT PROVIDED ANY TOOLS, DO NOT ATTEMPT TO USE ANY TOOLS. STOP AND LET THE USER KNOW THAT THERE ARE NO TOOLS AVAILABLE. The user can provide tools by enabling them in the Tool Policies section of the notch (wrench icon)";

export const BROKER_MODEL_LABELS: Record<string, string> = {
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
  "qwen-3-8-max": "Qwen 3.8 Max",
};

function brokerModelLabel(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return (
    BROKER_MODEL_LABELS[value] ??
    value.replace(/^(?:codex|kimi|grok):/, "").replaceAll("-", " ")
  );
}

function brokerModelAgent(value?: string): string | undefined {
  if (!value) return undefined;
  if (["opus-5", "sonnet-5", "fable-5", "haiku-4-5"].includes(value)) {
    return "claude";
  }
  if (value.startsWith("codex")) return "codex";
  if (value.startsWith("grok")) return "grok";
  if (value.startsWith("composer") || value.startsWith("cursor:"))
    return "cursor";
  if (value.startsWith("kimi")) return "claude";
  if (value.startsWith("deepseek")) return "deepseek";
  if (value.startsWith("qwen")) return "qwen";
  return undefined;
}

export function getBaseSystemMessage(
  messageMode: string,
  model: ModelDescription,
  activeTools?: Tool[],
  brokerModel?: string,
  brokerSubagent?: string,
): string {
  let baseMessage: string;

  if (messageMode === "agent") {
    baseMessage = model.baseAgentSystemMessage ?? DEFAULT_AGENT_SYSTEM_MESSAGE;
  } else if (messageMode === "broker") {
    baseMessage = model.baseAgentSystemMessage ?? DEFAULT_AGENT_SYSTEM_MESSAGE;
    const subagent =
      brokerSubagent && brokerSubagent !== "auto"
        ? brokerModelLabel(brokerSubagent)
        : "auto-select the strongest available worker";
    const subagentAgent =
      brokerSubagent && brokerSubagent !== "auto"
        ? brokerModelAgent(brokerSubagent)
        : undefined;
    const broker = brokerModelLabel(brokerModel) || "Fable 5";
    baseMessage += `\n\nYou are running in Cukii Broker mode. Broker model intent: ${broker}. Coordinate execution through the Cukii broker MCP tools when delegation is useful. Prefer broker_delegate for isolated worker tasks, broker_status to inspect work, and broker_accept only after reviewing results. Preferred subagent model: ${subagent}.${subagentAgent ? ` For broker_delegate use agent=\"${subagentAgent}\" and model=\"${subagent}\".` : " If Auto is selected, choose the strongest appropriate worker and explain the choice briefly."}`;
  } else if (messageMode === "plan") {
    baseMessage = model.basePlanSystemMessage ?? DEFAULT_PLAN_SYSTEM_MESSAGE;
  } else {
    baseMessage = model.baseChatSystemMessage ?? DEFAULT_CHAT_SYSTEM_MESSAGE;
  }

  // Add no-tools warning for agent/plan modes when no tools are available
  if (messageMode !== "chat" && (!activeTools || activeTools.length === 0)) {
    baseMessage += NO_TOOL_WARNING;
  }

  return baseMessage;
}
