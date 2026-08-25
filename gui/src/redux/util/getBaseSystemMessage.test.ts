import { ModelDescription, Tool } from "core";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_CHAT_SYSTEM_MESSAGE,
  DEFAULT_PLAN_SYSTEM_MESSAGE,
} from "core/llm/defaultSystemMessages";
import { getBaseSystemMessage, NO_TOOL_WARNING } from "./getBaseSystemMessage";

test("getBaseSystemMessage should return the correct system message based on mode", () => {
  const mockModel = {
    baseChatSystemMessage: "Custom Chat System Message",
    basePlanSystemMessage: "Custom Plan System Message",
    baseAgentSystemMessage: "Custom Agent System Message",
  } as ModelDescription;

  const mockTool = {
    function: {
      name: "testTool",
      description: "Test tool",
      parameters: {},
    },
  } as Tool;

  // Test agent mode with custom message and tools
  expect(getBaseSystemMessage("agent", mockModel, [mockTool])).toBe(
    "Custom Agent System Message",
  );

  // Test plan mode with custom message and tools
  expect(getBaseSystemMessage("plan", mockModel, [mockTool])).toBe(
    "Custom Plan System Message",
  );

  // Test chat mode with custom message and tools
  expect(getBaseSystemMessage("chat", mockModel, [mockTool])).toBe(
    "Custom Chat System Message",
  );

  // Test agent mode with default message and tools
  expect(
    getBaseSystemMessage("agent", {} as ModelDescription, [mockTool]),
  ).toBe(DEFAULT_AGENT_SYSTEM_MESSAGE);

  // Test plan mode with default message and tools
  expect(getBaseSystemMessage("plan", {} as ModelDescription, [mockTool])).toBe(
    DEFAULT_PLAN_SYSTEM_MESSAGE,
  );

  // Test chat mode with default message and tools
  expect(getBaseSystemMessage("chat", {} as ModelDescription, [mockTool])).toBe(
    DEFAULT_CHAT_SYSTEM_MESSAGE,
  );

  expect(
    getBaseSystemMessage("broker", mockModel, [mockTool], "fable-5", "opus-5"),
  ).toBe(
    'Custom Agent System Message\n\nYou are running in Cukii Broker mode. Broker model intent: Fable 5. Coordinate execution through the Cukii broker MCP tools when delegation is useful. Prefer broker_delegate for isolated worker tasks, broker_status to inspect work, and broker_accept only after reviewing results. Preferred subagent model: Opus 5. For broker_delegate use agent="claude" and model="Opus 5".',
  );
});

test("getBaseSystemMessage should append no-tools warning for agent/plan modes without tools", () => {
  const mockModel = {
    baseChatSystemMessage: "Custom Chat System Message",
    basePlanSystemMessage: "Custom Plan System Message",
    baseAgentSystemMessage: "Custom Agent System Message",
  } as ModelDescription;

  // Test agent mode without tools
  expect(getBaseSystemMessage("agent", mockModel, [])).toBe(
    "Custom Agent System Message" + NO_TOOL_WARNING,
  );

  // Test plan mode without tools
  expect(getBaseSystemMessage("plan", mockModel, [])).toBe(
    "Custom Plan System Message" + NO_TOOL_WARNING,
  );

  // Test chat mode without tools (should not append warning)
  expect(getBaseSystemMessage("chat", mockModel, [])).toBe(
    "Custom Chat System Message",
  );

  // Test agent mode with undefined tools
  expect(getBaseSystemMessage("agent", mockModel)).toBe(
    "Custom Agent System Message" + NO_TOOL_WARNING,
  );

  // Test plan mode with undefined tools
  expect(getBaseSystemMessage("plan", mockModel)).toBe(
    "Custom Plan System Message" + NO_TOOL_WARNING,
  );

  expect(getBaseSystemMessage("broker", mockModel, [], "fable-5", "auto")).toBe(
    "Custom Agent System Message\n\nYou are running in Cukii Broker mode. Broker model intent: Fable 5. Coordinate execution through the Cukii broker MCP tools when delegation is useful. Prefer broker_delegate for isolated worker tasks, broker_status to inspect work, and broker_accept only after reviewing results. Preferred subagent model: auto-select the strongest available worker. If Auto is selected, choose the strongest appropriate worker and explain the choice briefly." +
      NO_TOOL_WARNING,
  );
});
