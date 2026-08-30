import { ToolCallState } from "core";
import { useMemo, useState } from "react";
import { commandShellLabel } from "./shellLabel";

const OUTPUT_PREVIEW_LINES = 60;

function terminalOutput(toolCallState: ToolCallState): string {
  const isFailure =
    toolCallState.status === "errored" || toolCallState.status === "canceled";
  const output = isFailure
    ? toolCallState.output?.[0]
    : toolCallState.output?.find((item) => item.name === "Terminal") ??
      toolCallState.output?.[0];
  return output?.content ?? "";
}

interface CukiiCommandCardProps {
  command: string;
  toolCallState: ToolCallState;
}

/** A small, accessible command transcript: input and output stay distinct. */
export function CukiiCommandCard({
  command,
  toolCallState,
}: CukiiCommandCardProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAllOutput, setShowAllOutput] = useState(false);
  const output = terminalOutput(toolCallState);
  const trustedShell =
    toolCallState.processedArgs?.shell ??
    toolCallState.processedArgs?.shellType ??
    toolCallState.parsedArgs?.shell ??
    toolCallState.parsedArgs?.shellType;
  const shell = commandShellLabel(command, trustedShell);
  const isRunning = toolCallState.status === "calling";
  const outputPreview = useMemo(() => {
    const lines = output.split("\n");
    if (lines.length <= OUTPUT_PREVIEW_LINES) {
      return { text: output, hiddenLineCount: 0 };
    }
    return {
      text: lines.slice(-OUTPUT_PREVIEW_LINES).join("\n"),
      hiddenLineCount: lines.length - OUTPUT_PREVIEW_LINES,
    };
  }, [output]);
  const outputText = showAllOutput ? output : outputPreview.text;

  return (
    <section
      className="cukii-command-card"
      data-testid="cukii-command-card"
      aria-label={`${shell} command`}
    >
      <button
        type="button"
        className="cukii-command-card-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="cukii-command-shell">{shell}</span>
        <span className="cukii-command-description">Run command</span>
        <span className="cukii-command-card-toggle">
          {expanded ? "Collapse" : "Expand"}
        </span>
      </button>
      {expanded && (
        <div className="cukii-command-card-panel">
          <div className="cukii-command-section-label">IN</div>
          <pre className="cukii-command-code" data-testid="cukii-command-input">
            {command}
          </pre>
          <div className="cukii-command-section-label">OUT</div>
          {output ? (
            <>
              <pre
                className="cukii-command-code cukii-command-output"
                data-testid="cukii-command-output"
              >
                {outputText}
              </pre>
              {outputPreview.hiddenLineCount > 0 && (
                <button
                  type="button"
                  className="cukii-command-output-toggle"
                  aria-expanded={showAllOutput}
                  onClick={() => setShowAllOutput((value) => !value)}
                >
                  {showAllOutput
                    ? "Show recent output"
                    : `Show ${outputPreview.hiddenLineCount} earlier lines`}
                </button>
              )}
            </>
          ) : (
            <div
              className="cukii-command-empty-output"
              data-testid="cukii-command-output"
            >
              {isRunning ? "Running…" : "No output"}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
