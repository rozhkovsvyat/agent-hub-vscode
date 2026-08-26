// src/components/ThinkingBlockPeek.tsx
import { ChevronDownIcon } from "@heroicons/react/24/outline";
import { ChevronUpIcon } from "@heroicons/react/24/solid";
import { ChatHistoryItem } from "core";
import { useEffect, useState } from "react";
import styled from "styled-components";

import StyledMarkdownPreview from "../../StyledMarkdownPreview";
import { useAppSelector } from "../../../redux/hooks";
import { Button } from "../../ui";

const MarkdownWrapper = styled.div`
  & > div > *:first-child {
    margin-top: 0 !important;
  }
`;

interface ThinkingBlockPeekProps {
  content: string;
  redactedThinking?: string;
  index: number;
  prevItem: ChatHistoryItem | null;
  inProgress?: boolean;
  signature?: string;
  tokens?: number;
}

function ThinkingBlockPeek({
  content,
  redactedThinking,
  index,
  prevItem,
  inProgress,
  tokens,
}: ThinkingBlockPeekProps) {
  const [open, setOpen] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<string>("");
  const thinkingCollapse = useAppSelector((state) => state.ui.thinkingCollapse);
  const focusView = useAppSelector((state) => state.ui.focusView);

  useEffect(() => {
    if (focusView) {
      setOpen(false);
      return;
    }
    if (thinkingCollapse.version === 0) {
      return;
    }
    setOpen(thinkingCollapse.open);
  }, [thinkingCollapse.version, thinkingCollapse.open, focusView]);

  const duplicateRedactedThinkingBlock =
    prevItem &&
    prevItem.message.role === "thinking" &&
    redactedThinking &&
    prevItem.message.redactedThinking;

  useEffect(() => {
    if (inProgress) {
      setStartTime(Date.now());
      setElapsedTime("");
    } else if (startTime) {
      const endTime = Date.now();
      const diff = endTime - startTime;
      const diffString = `${(diff / 1000).toFixed(1)}s`;
      setElapsedTime(diffString);
    }
  }, [inProgress]);

  return duplicateRedactedThinkingBlock ? null : (
    <div className="thread-message">
      <div className="mt-1 flex flex-col px-4">
        <div>
          <Button
            // ghost, а не outline: у Клода пилюля размышлений без рамки —
            // видна только надпись, а фон появляется лишь на hover.
            variant="ghost"
            className="text-description flex-0 m-0 mb-2 flex min-w-0 cursor-pointer flex-row items-center gap-1.5 rounded-full px-2 text-xs transition-colors duration-200 ease-in-out hover:brightness-125"
            data-testid="thinking-block-peek"
            aria-expanded={open}
            aria-controls={`thinking-block-content-${index}`}
            onClick={() => setOpen(!open)}
          >
            {inProgress
              ? redactedThinking
                ? "Redacted thinking"
                : "Thinking"
              : redactedThinking
                ? "Redacted Thinking"
                : "Thought" +
                  (elapsedTime ? ` for ${elapsedTime}` : "") +
                  (tokens ? ` (${tokens} tokens)` : "")}
            {open ? (
              <ChevronUpIcon className="h-3 w-3" />
            ) : (
              <ChevronDownIcon className="h-3 w-3" />
            )}
          </Button>
        </div>
        <div
          id={`thinking-block-content-${index}`}
          className={`overflow-y-auto transition-all duration-300 ease-in-out ${
            open ? "max-h-[50vh] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          {redactedThinking ? (
            <div className="text-description pl-5 text-xs italic">
              Thinking content redacted due to safety reasons.
            </div>
          ) : (
            <MarkdownWrapper className="text-description">
              <StyledMarkdownPreview
                isRenderingInStepContainer
                source={content}
                itemIndex={index}
              />
            </MarkdownWrapper>
          )}
        </div>
      </div>
    </div>
  );
}

export default ThinkingBlockPeek;
