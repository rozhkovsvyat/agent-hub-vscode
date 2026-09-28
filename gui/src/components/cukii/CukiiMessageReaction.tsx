import type { CukiiUserReactionEmoji } from "core/protocol/ideWebview";
import { MAX_REACTION_EMOJI_DATA_URL } from "./maxReactionEmojiData";

const AGENT_REACTION_EMOJIS = new Set<CukiiUserReactionEmoji>([
  "❤️",
  "😂",
  "👍",
  "🔥",
  "👏",
  "😮",
  "😢",
  "🤝",
]);

export type CukiiAgentReaction = {
  reactionId: string;
  emoji: CukiiUserReactionEmoji;
  reactedAt: number;
  source: "agent";
};

export function readCukiiAgentReaction(
  metadata: Record<string, unknown> | undefined,
): CukiiAgentReaction | undefined {
  const candidate = metadata?.cukiiReaction;
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const reaction = candidate as Record<string, unknown>;
  if (
    typeof reaction.reactionId !== "string" ||
    reaction.reactionId.length === 0 ||
    typeof reaction.emoji !== "string" ||
    !AGENT_REACTION_EMOJIS.has(reaction.emoji as CukiiUserReactionEmoji) ||
    !Number.isFinite(reaction.reactedAt) ||
    reaction.source !== "agent"
  ) {
    return undefined;
  }
  return reaction as CukiiAgentReaction;
}

export function CukiiMessageReaction({
  reaction,
}: {
  reaction: CukiiAgentReaction;
}) {
  return (
    <div
      aria-label={`Agent reacted ${reaction.emoji}`}
      className="cukii-user-reactions"
      data-cukii-reaction-id={reaction.reactionId}
      data-testid={`cukii-user-reaction-${reaction.reactionId}`}
      role="img"
    >
      <span className="cukii-message-reaction">
        <span aria-hidden="true" className="cukii-message-reaction-emoji">
          <img
            alt=""
            className="cukii-message-reaction-art"
            draggable={false}
            onError={(event) => {
              event.currentTarget.hidden = true;
              event.currentTarget.nextElementSibling?.removeAttribute("hidden");
            }}
            src={MAX_REACTION_EMOJI_DATA_URL[reaction.emoji]}
          />
          <span className="cukii-message-reaction-fallback" hidden>
            {reaction.emoji}
          </span>
        </span>
        <span aria-hidden="true" className="cukii-message-reaction-counter">
          1
        </span>
      </span>
    </div>
  );
}
