import { ChatHistoryItem } from "core";
import { renderChatMessage, stripImages } from "core/util/messageContent";
import { memo } from "react";
import { useAppSelector } from "../../redux/hooks";
import { selectUIConfig } from "../../redux/slices/configSlice";
import { formatMessageTime } from "../../util/formatMessageTime";
import ThinkingBlockPeek from "../mainInput/belowMainInput/ThinkingBlockPeek";
import StyledMarkdownPreview from "../StyledMarkdownPreview";
import ConversationSummary from "./ConversationSummary";
import ThinkingIndicator from "./ThinkingIndicator";

interface StepContainerProps {
  item: ChatHistoryItem & { createdAt?: number };
  index: number;
  isLast: boolean;
  latestSummaryIndex?: number;
}

function StepContainer(props: StepContainerProps) {
  const uiConfig = useAppSelector(selectUIConfig);

  // Calculate dimming and indicator state based on latest summary index
  const latestSummaryIndex = props.latestSummaryIndex ?? -1;
  const isBeforeLatestSummary =
    latestSummaryIndex !== -1 && props.index <= latestSummaryIndex;
  const isLatestSummary =
    latestSummaryIndex !== -1 && props.index === latestSummaryIndex;

  return (
    <div>
      <div
        className={`cukii-assistant-bubble bg-background p-1 px-1.5 ${isBeforeLatestSummary ? "opacity-35" : ""}`}
      >
        {uiConfig?.displayRawMarkdown ? (
          <pre className="text-2xs max-w-full overflow-x-auto whitespace-pre-wrap break-words p-4">
            {renderChatMessage(props.item.message)}
          </pre>
        ) : (
          <>
            {props.item.reasoning?.text?.trim() && (
              <ThinkingBlockPeek
                content={props.item.reasoning.text}
                index={props.index}
                prevItem={props.index > 0 ? props.item : null}
                inProgress={!props.item.reasoning?.endAt}
              />
            )}

            <StyledMarkdownPreview
              isRenderingInStepContainer
              useParentBackgroundColor
              source={stripImages(props.item.message.content)}
              itemIndex={props.index}
            />
          </>
        )}
        {props.isLast && !props.item.reasoning?.text?.trim() && (
          <ThinkingIndicator historyItem={props.item} />
        )}
        {formatMessageTime(props.item.createdAt) !== undefined && (
          <span className="cukii-assistant-metadata">
            <time>{formatMessageTime(props.item.createdAt)}</time>
          </span>
        )}
      </div>

      {/* Show compaction indicator for the latest summary */}
      {isLatestSummary && (
        <div className="mx-1.5 my-5">
          <div className="flex items-center">
            <div className="border-border flex-1 border-t border-solid"></div>
            <span className="text-description mx-3 text-xs">
              Previous Conversation Compacted
            </span>
            <div className="border-border flex-1 border-t border-solid"></div>
          </div>
        </div>
      )}

      {/* ConversationSummary is outside the dimmed container so it's always at full opacity */}
      <ConversationSummary item={props.item} index={props.index} />
    </div>
  );
}

// Chat can reconcile for unrelated controls (for example a bridge receipt) while
// a large restored transcript is visible. The history item and its position are
// immutable between transcript changes, so avoid re-running markdown rendering
// for every visible assistant row in that case.
export default memo(StepContainer);
