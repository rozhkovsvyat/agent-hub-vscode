import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CukiiMessageReaction,
  readCukiiAgentReaction,
} from "./CukiiMessageReaction";
import { MAX_REACTION_EMOJI_DATA_URL } from "./maxReactionEmojiData";

describe("CukiiMessageReaction", () => {
  it("renders a MAX-style one-person agent reaction", () => {
    const reaction = readCukiiAgentReaction({
      cukiiReaction: {
        reactionId: "reaction-a",
        emoji: "😂",
        reactedAt: 42,
        source: "agent",
      },
    });
    expect(reaction).toBeDefined();
    render(<CukiiMessageReaction reaction={reaction!} />);
    const rendered = screen.getByRole("img", { name: "Agent reacted 😂" });
    expect(rendered).toHaveTextContent("😂1");
    expect(rendered.querySelector("img")).toHaveAttribute(
      "src",
      MAX_REACTION_EMOJI_DATA_URL["😂"],
    );
  });

  it("overlaps the bubble edge like MAX without reserving a second row", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    const container =
      css.match(/\.cukii-user-reactions\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(container).toContain("position: absolute");
    expect(container).toContain("inset-inline-start: 8px");
    expect(container).toContain("bottom: -14px");
    expect(container).not.toContain("min-height");
    expect(container).not.toContain("padding:");
  });

  it("embeds all supported MAX emoji artwork as valid WebP data", () => {
    expect(Object.keys(MAX_REACTION_EMOJI_DATA_URL)).toHaveLength(8);
    expect(new Set(Object.values(MAX_REACTION_EMOJI_DATA_URL)).size).toBe(8);
    for (const dataUrl of Object.values(MAX_REACTION_EMOJI_DATA_URL)) {
      expect(dataUrl).toMatch(/^data:image\/webp;base64,/);
      const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(bytes.length).toBeGreaterThan(500);
    }
  });

  it("refuses unknown, forged or incomplete reaction metadata", () => {
    expect(
      readCukiiAgentReaction({
        cukiiReaction: {
          reactionId: "reaction-a",
          emoji: "💣",
          reactedAt: 42,
          source: "agent",
        },
      }),
    ).toBeUndefined();
    expect(
      readCukiiAgentReaction({
        cukiiReaction: {
          reactionId: "reaction-a",
          emoji: "❤️",
          reactedAt: 42,
          source: "user",
        },
      }),
    ).toBeUndefined();
  });
});
