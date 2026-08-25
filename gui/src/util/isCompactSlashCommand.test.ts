import { JSONContent } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { isCompactSlashCommand } from "./isCompactSlashCommand";

describe("isCompactSlashCommand", () => {
  it("detects compact prompt-block nodes", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "prompt-block",
          attrs: { item: { name: "compact" } },
        },
      ],
    };

    expect(isCompactSlashCommand(editorState)).toBe(true);
  });

  it("detects plain /compact text", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "/compact" }],
        },
      ],
    };

    expect(isCompactSlashCommand(editorState)).toBe(true);
  });

  it("ignores other slash commands", () => {
    const editorState: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "/init" }],
        },
      ],
    };

    expect(isCompactSlashCommand(editorState)).toBe(false);
  });
});
