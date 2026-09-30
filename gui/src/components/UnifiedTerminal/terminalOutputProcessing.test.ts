import {
  collapseTerminalBlankRuns,
  processTerminalOutput,
  TERMINAL_MAX_LINE_CHARS,
} from "./terminalOutputProcessing";

describe("collapseTerminalBlankRuns", () => {
  test("collapses long blank runs to a single blank line", () => {
    const output = ["start", "", "", "", "", "", "end"].join("\n");
    expect(collapseTerminalBlankRuns(output)).toBe(
      ["start", "", "end"].join("\n"),
    );
  });

  test("keeps short blank runs intact", () => {
    const output = ["a", "", "", "b"].join("\n");
    expect(collapseTerminalBlankRuns(output)).toBe(output);
  });

  test("keeps ANSI-only lines so colour state survives collapsing", () => {
    // An SGR-only line carries the colour state of the following output;
    // collapsing it as blank made the next line repaint in the wrong colour
    // (Fable review MINOR-8).
    const output = ["a", "", "\u001b[32m\u001b[0m", "", "", "b"].join("\n");
    // The SGR-only line splits the blank run and is itself preserved.
    expect(collapseTerminalBlankRuns(output)).toBe(output);
  });

  test("leaves single-line output untouched", () => {
    expect(collapseTerminalBlankRuns("x".repeat(10_000))).toHaveLength(10_000);
  });
});

describe("processTerminalOutput", () => {
  test("returns empty shape for empty output", () => {
    expect(processTerminalOutput("", 15).isLimited).toBe(false);
  });

  test("passes through short multi-line output", () => {
    const output = ["one", "two", "three"].join("\n");
    const result = processTerminalOutput(output, 15);
    expect(result.isLimited).toBe(false);
    expect(result.fullContent).toBe(output);
  });

  test("limits by virtual rows for classic long output", () => {
    const output = Array.from({ length: 25 }, (_, i) => `Line ${i + 1}`).join(
      "\n",
    );
    const result = processTerminalOutput(output, 10);
    expect(result.isLimited).toBe(true);
    expect(result.hiddenLinesCount).toBe(15);
    expect(result.limitedContent).toContain("Line 25");
    expect(result.limitedContent).toContain("Line 16");
    expect(result.limitedContent).not.toContain("Line 15\n");
  });

  test("a single megabyte line cannot bypass the limit", () => {
    const giant = "A".repeat(TERMINAL_MAX_LINE_CHARS * 40);
    const result = processTerminalOutput(giant, 15);
    expect(result.isLimited).toBe(true);
    expect(result.hiddenLinesCount).toBe(25);
    // Limited view keeps only whole 500-char segments inside the budget.
    expect(result.limitedContent.length).toBe(TERMINAL_MAX_LINE_CHARS * 15);
    expect(result.fullContent.length).toBe(TERMINAL_MAX_LINE_CHARS * 40);
  });

  test("mixed output: giant line plus regular tail lines", () => {
    const output = [
      "header",
      "B".repeat(TERMINAL_MAX_LINE_CHARS * 10),
      "tail-1",
      "tail-2",
    ].join("\n");
    const result = processTerminalOutput(output, 4);
    expect(result.isLimited).toBe(true);
    expect(result.limitedContent).toContain("tail-1");
    expect(result.limitedContent).toContain("tail-2");
    // Budget 4: two tail lines + two 500-char segments of the giant line.
    expect(result.limitedContent).toContain(
      "B".repeat(TERMINAL_MAX_LINE_CHARS),
    );
    expect(result.limitedContent.length).toBeLessThan(output.length);
  });

  test("blank runs collapse before limiting so they cannot inflate the count", () => {
    const output = [
      "start",
      ...Array.from({ length: 30 }, () => ""),
      ...Array.from({ length: 12 }, (_, i) => `data-${i}`),
    ].join("\n");
    const result = processTerminalOutput(output, 15);
    // After collapsing, content fits the budget: no limit engaged at all.
    expect(result.isLimited).toBe(false);
    expect(result.limitedContent).not.toContain("\n\n\n");
    // Copy and the expanded card keep the vendor bytes verbatim.
    expect(result.fullContent).toBe(output);
  });

  test("keeps ANSI-only lines so colour state survives collapsing", () => {
    const output = ["red", "\u001b[0m", "\u001b[0m", "\u001b[0m", "after"].join(
      "\n",
    );
    const result = processTerminalOutput(output, 10);
    expect(result.limitedContent).toContain("\u001b[0m");
  });

  test("hiddenLinesCount reports virtual rows, not logical lines", () => {
    const output = ["x".repeat(TERMINAL_MAX_LINE_CHARS * 5), "plain"].join(
      "\n",
    );
    const result = processTerminalOutput(output, 2);
    expect(result.totalLines).toBe(6);
    expect(result.hiddenLinesCount).toBe(4);
  });
});
