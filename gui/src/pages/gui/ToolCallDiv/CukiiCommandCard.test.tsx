import { fireEvent, render, screen } from "@testing-library/react";
import { ToolCallState } from "core";
import { describe, expect, it } from "vitest";
import { CukiiCommandCard } from "./CukiiCommandCard";

function state(
  output: string,
  parsedArgs: Record<string, unknown> = {},
): ToolCallState {
  return {
    toolCallId: "bash-1",
    toolCall: {
      id: "bash-1",
      type: "function",
      function: { name: "run_terminal_command", arguments: "{}" },
    },
    parsedArgs,
    status: "done",
    output: [{ name: "Terminal", description: "", content: output }],
  };
}

describe("CukiiCommandCard", () => {
  it("keeps command input and output in explicit, collapsible sections", async () => {
    render(
      <CukiiCommandCard
        command="Get-ChildItem src"
        toolCallState={state("a\nb")}
      />,
    );
    expect(screen.getByText("PowerShell")).toBeTruthy();
    expect(screen.getByText("Run command")).toBeTruthy();
    expect(screen.getByText("IN")).toBeTruthy();
    expect(screen.getByText("OUT")).toBeTruthy();
    expect(screen.getByTestId("cukii-command-input").textContent).toBe(
      "Get-ChildItem src",
    );
    expect(screen.getByTestId("cukii-command-output").textContent).toBe("a\nb");
    const header = screen.getByRole("button", {
      name: /PowerShell.*Run command/,
    });
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("IN")).toBeNull();
  });

  it("limits a large output until the reader explicitly expands it", async () => {
    const output = Array.from(
      { length: 65 },
      (_, index) => `line-${index}`,
    ).join("\n");
    render(<CukiiCommandCard command="ls" toolCallState={state(output)} />);
    expect(screen.getByText("Show 5 earlier lines")).toBeTruthy();
    expect(
      screen.getByTestId("cukii-command-output").textContent,
    ).not.toContain("line-0");
    fireEvent.click(screen.getByText("Show 5 earlier lines"));
    expect(screen.getByTestId("cukii-command-output").textContent).toContain(
      "line-0",
    );
  });

  it("prefers trusted shell metadata over command-text heuristics", () => {
    render(
      <CukiiCommandCard
        command="Write-Output portable"
        toolCallState={state("portable", { shell: "/bin/bash" })}
      />,
    );
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.queryByText("PowerShell")).toBeNull();
  });

  it("keeps a long unbroken path inside the command transcript after collapse and reopen", () => {
    const longPath = `C:/${"very-long-segment/".repeat(24)}final-file.ts`;
    render(
      <CukiiCommandCard
        command={`Get-Content ${longPath}`}
        toolCallState={state("done")}
      />,
    );

    const header = screen.getByRole("button", {
      name: /PowerShell.*Run command/,
    });
    expect(screen.getByTestId("cukii-command-input").textContent).toContain(
      longPath,
    );

    fireEvent.click(header);
    expect(screen.queryByTestId("cukii-command-input")).toBeNull();
    fireEvent.click(header);
    expect(screen.getByTestId("cukii-command-input").textContent).toContain(
      longPath,
    );
  });
});
