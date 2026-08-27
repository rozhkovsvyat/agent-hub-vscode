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
  "fable-5": "Fable 5",
  "codex-5-6-terra": "Codex 5.6 Terra",
  "grok-4-6": "Grok 4.6",
  "composer-2-5": "Composer 2.5",
  "qwen-3-8-max": "Qwen 3.8 Max",
};

const BROKER_MODEL_AGENTS: Record<string, string> = {
  "opus-5": "claude",
  "fable-5": "claude",
  "codex-5-6-terra": "codex",
  "grok-4-6": "grok",
  "composer-2-5": "cursor",
  "qwen-3-8-max": "qwen",
};

function brokerModelLabel(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  return BROKER_MODEL_LABELS[value] ?? value;
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
        ? BROKER_MODEL_AGENTS[brokerSubagent]
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
