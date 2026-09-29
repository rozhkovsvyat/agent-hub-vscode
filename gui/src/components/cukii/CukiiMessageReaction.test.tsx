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
    render(
      <>
        <CukiiMessageReaction
          placement="embedded"
          reaction={reaction!}
          surface="user"
        />
        <CukiiMessageReaction
          placement="embedded"
          reaction={{ ...reaction!, reactionId: "reaction-assistant" }}
          surface="assistant"
        />
      </>,
    );
    const rendered = screen.getAllByRole("img", { name: "Agent reacted 😂" });
    expect(rendered[0]).toHaveTextContent("😂1");
    expect(rendered[0]).toHaveClass(
      "cukii-message-reactions--embedded",
      "cukii-message-reactions--user",
    );
    expect(rendered[1]).toHaveClass(
      "cukii-message-reactions--embedded",
      "cukii-message-reactions--assistant",
    );
    expect(rendered[0].querySelector("img")).toHaveAttribute(
      "src",
      MAX_REACTION_EMOJI_DATA_URL["😂"],
    );
  });

  it("embeds text-message reactions and reserves a standalone pill for media-only messages", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    const embedded =
      css.match(/\.cukii-message-reactions--embedded\s*\{([^}]*)\}/)?.[1] ?? "";
    const standalone =
      css.match(/\.cukii-message-reactions--standalone\s*\{([^}]*)\}/)?.[1] ??
      "";
    expect(embedded).toContain("position: static");
    expect(embedded).toContain("padding: 8px 10px");
    expect(embedded).not.toContain("bottom:");
    expect(standalone).toContain("position: static");
    expect(standalone).toContain("padding: 4px 0 8px");
    expect(standalone).not.toContain("bottom:");
  });

  it("uses the opposite message surface and the owner-requested counter colors", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    const userPill =
      css.match(/\.cukii-message-reactions--user[^\{]*\{([^}]*)\}/)?.[1] ?? "";
    const assistantPill =
      css.match(/\.cukii-message-reactions--assistant[^\{]*\{([^}]*)\}/)?.[1] ??
      "";
    const userCounter =
      css.match(
        /\.cukii-message-reactions--user \.cukii-message-reaction-counter\s*\{([^}]*)\}/,
      )?.[1] ?? "";
    const assistantCounter =
      css.match(
        /\.cukii-message-reactions--assistant \.cukii-message-reaction-counter\s*\{([^}]*)\}/,
      )?.[1] ?? "";

    expect(userPill).toContain("var(--vscode-input-background");
    expect(assistantPill).toContain("var(--cukii-primary-action-background");
    expect(userCounter).toContain(
      "var(--cukii-primary-action-background, #e3a867)",
    );
    expect(assistantCounter).toContain("#ffffff");
  });

  it("keeps the reaction and delivery metadata on the same MAX bottom row", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    expect(css).toMatch(
      /\.cukii-user-bubble--reaction-with-meta[\s\S]*?\.cukii-message-reactions--embedded::after\s*\{[^}]*content:\s*"";[^}]*width:\s*var\(--cukii-meta-reserve/s,
    );
    expect(css).toMatch(
      /\.cukii-user-bubble--reaction-with-meta\s*>\s*\.cukii-user-metadata,[\s\S]*?\.cukii-user-bubble--reaction-with-meta\s*>\s*\.cukii-user-fold-footer\s*\{[^}]*position:\s*absolute;[^}]*right:\s*10px;[^}]*bottom:\s*4px/s,
    );
    // A text reaction already reserves the receipt in its own bottom row.
    // Reusing the ordinary prose spacer as well makes a short narrow message
    // wrap to two lines and falsely enter the sticky-fold state.
    expect(css).toMatch(
      /\.cukii-user-bubble--meta-inline:not\(\.cukii-user-bubble--reaction-with-meta\)[\s\S]*?\.ProseMirror[\s\S]*?p:last-child::after\s*\{/s,
    );
    expect(css).not.toMatch(
      /\.cukii-user-bubble--meta-inline\s+\.ProseMirror\s+p:last-child::after\s*\{/s,
    );
    expect(css).toMatch(
      /\.cukii-user-message-bubble\[data-cukii-long-prompt="true"\]:not\(\s*\.cukii-user-bubble--reaction-with-meta\s*\)[\s\S]*?p:last-child::after\s*\{/s,
    );
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
