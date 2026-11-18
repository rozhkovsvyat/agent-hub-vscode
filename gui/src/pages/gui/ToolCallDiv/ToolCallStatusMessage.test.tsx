import { render, screen } from "@testing-library/react";
import { Tool, ToolCallState } from "core";
import { describe, expect, it } from "vitest";
import { ToolCallStatusMessage } from "./ToolCallStatusMessage";
import { TOOL_INTERRUPTED_MESSAGE } from "core/tools/constants";

function state(
  overrides: Partial<ToolCallState> & {
    name?: string;
    args?: Record<string, unknown>;
  },
): ToolCallState {
  const name = overrides.name ?? "read_file";
  return {
    status: "done",
    toolCallId: "t1",
    toolCall: {
      id: "t1",
      type: "function",
      function: { name, arguments: "{}" },
    },
    parsedArgs: overrides.args ?? { path: "gui/src/Chat.tsx" },
    ...overrides,
  };
}

const registeredTool = {
  displayTitle: "Read file",
  function: { name: "read_file" },
} as Tool;

describe("ToolCallStatusMessage", () => {
  it("does not prefix registered tools with Continue", () => {
    render(
      <ToolCallStatusMessage tool={registeredTool} toolCallState={state({})} />,
    );
    const title = screen.getByTestId("tool-call-title");
    expect(title.textContent).not.toMatch(/Continue/i);
    expect(title).toHaveTextContent("Read file");
    expect(title).toHaveTextContent("gui/src/Chat.tsx");
  });

  it("shows the native worker tool name and path", () => {
    render(
      <ToolCallStatusMessage
        tool={undefined}
        toolCallState={state({ name: "Read", args: { file_path: "a.ts" } })}
      />,
    );
    const title = screen.getByTestId("tool-call-title");
    expect(title.textContent).not.toMatch(/Continue/i);
    expect(title).toHaveTextContent("Read");
    expect(title).toHaveTextContent("a.ts");
  });

  it("shows interrupted message on canceled calls", () => {
    render(
      <ToolCallStatusMessage
        tool={registeredTool}
        toolCallState={state({ status: "canceled" })}
      />,
    );
    const title = screen.getByTestId("tool-call-title");
    expect(title).toHaveTextContent(TOOL_INTERRUPTED_MESSAGE);
    expect(title.textContent).not.toMatch(/tried/);
  });
});
