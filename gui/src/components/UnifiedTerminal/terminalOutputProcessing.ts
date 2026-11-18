// Output shaping for UnifiedTerminalCommand. Pure and unit-tested: the
// component only wires the result into AnsiRenderer.

/** A single logical line longer than this renders as several visual rows, so
 * counting only `\n` lines let megabyte-long base64/minified payloads bypass
 * the "+N more lines" limit entirely (measured in real sessions). */
export const TERMINAL_MAX_LINE_CHARS = 500;

/** Runs of at least this many blank lines collapse to a single blank line, so
 * a command that prints empty stretches cannot flood the chat with blank
 * bands (owner video: expanded card with hundreds of empty pixels). */
export const TERMINAL_BLANK_RUN_COLLAPSE = 3;

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

function isBlankLine(line: string): boolean {
  // A line carrying only control sequences is NOT blank: collapsing it would
  // drop the SGR state that colours the following output (Fable review).
  if (line.includes("\u001b")) return false;
  return line.replace(ANSI_PATTERN, "").trim().length === 0;
}

export function collapseTerminalBlankRuns(
  output: string,
  maxRun: number = TERMINAL_BLANK_RUN_COLLAPSE,
): string {
  if (!output.includes("\n")) return output;
  const lines = output.split("\n");
  const kept: string[] = [];
  let pendingBlank = 0;
  const flushBlankRun = () => {
    if (pendingBlank === 0) return;
    // Short runs render verbatim; long runs collapse to one blank line.
    const visible = pendingBlank < maxRun ? pendingBlank : 1;
    for (let i = 0; i < visible; i++) kept.push("");
    pendingBlank = 0;
  };
  for (const line of lines) {
    if (isBlankLine(line)) {
      pendingBlank += 1;
      continue;
    }
    flushBlankRun();
    kept.push(line);
  }
  flushBlankRun();
  return kept.join("\n");
}

/** Virtual visual rows a logical line occupies after soft wrapping at the
 * terminal's render width proxy. */
function virtualLineCount(line: string): number {
  if (line.length <= TERMINAL_MAX_LINE_CHARS) return 1;
  return Math.ceil(line.length / TERMINAL_MAX_LINE_CHARS);
}

export interface ProcessedTerminalOutput {
  fullContent: string;
  limitedContent: string;
  totalLines: number;
  isLimited: boolean;
  hiddenLinesCount: number;
}

export function processTerminalOutput(
  rawOutput: string,
  displayLines: number,
): ProcessedTerminalOutput {
  const empty: ProcessedTerminalOutput = {
    fullContent: "",
    limitedContent: "",
    totalLines: 0,
    isLimited: false,
    hiddenLinesCount: 0,
  };
  if (!rawOutput) return empty;

  // The limited view is shaped; Copy and the expanded card keep the vendor's
  // bytes verbatim so colour state and blank stretches survive (Fable review).
  const output = collapseTerminalBlankRuns(rawOutput);
  const lines = output.split("\n");
  const virtualTotal = lines.reduce(
    (sum, line) => sum + virtualLineCount(line),
    0,
  );

  if (virtualTotal <= displayLines) {
    return {
      fullContent: rawOutput,
      limitedContent: output,
      totalLines: virtualTotal,
      isLimited: false,
      hiddenLinesCount: 0,
    };
  }

  // Walk logical lines from the end until the virtual budget is spent; a
  // giant tail line is truncated to whole 500-char segments so the limited
  // view never mounts a megabyte of unbroken text.
  const kept: string[] = [];
  let budget = displayLines;
  for (let index = lines.length - 1; index >= 0 && budget > 0; index--) {
    const line = lines[index];
    const cost = virtualLineCount(line);
    if (cost <= budget) {
      kept.unshift(line);
      budget -= cost;
      continue;
    }
    const keptSegments = line.slice(-budget * TERMINAL_MAX_LINE_CHARS);
    // A cut can land inside an SGR sequence: either the introducer stays
    // before the cut (orphan "94m" prefix) or right after ESC (orphan
    // "[0;94m" prefix). Drop exactly those two shapes; a line that merely
    // starts with the letter m (e.g. "make …") keeps its first character
    // (Fable review M6a/R2).
    kept.unshift(keptSegments.replace(/^(?:\x1b?\[[0-9;]*m|[0-9;]+m)/, ""));
    budget = 0;
  }

  return {
    fullContent: rawOutput,
    limitedContent: kept.join("\n"),
    totalLines: virtualTotal,
    isLimited: true,
    hiddenLinesCount: virtualTotal - displayLines,
  };
}
