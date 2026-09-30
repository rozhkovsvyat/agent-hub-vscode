import type { JSONContent } from "@tiptap/react";
import type { MessageContent } from "core";
import { stripImages } from "core/util/messageContent";

/** Build a ProseMirror doc from plain text, one paragraph per line. TipTap's
 * `content` option parses strings as HTML, where newlines are insignificant
 * whitespace — so broker-injected or migrated plain-text prompts used to
 * collapse into a single visual line (owner card: sent messages ignore line
 * breaks). Paragraphs make the breaks structural instead of CSS-dependent. */
export function plainTextToEditorDoc(text: string): JSONContent {
  return {
    type: "doc",
    content: text
      .split("\n")
      .map((line) =>
        line.length
          ? { type: "paragraph", content: [{ type: "text", text: line }] }
          : { type: "paragraph" },
      ),
  };
}

/** History items submitted through the composer carry a saved rich
 * `editorState`; items injected by the broker inbox, another device, or older
 * migrations carry only plain `message.content`. Convert that fallback into a
 * doc instead of handing TipTap a raw HTML-parseable string. Multimodal parts
 * without a saved editor state keep their text (image payloads have no
 * renderable source in this path either way). */
export function messageContentToEditorDoc(
  content: MessageContent,
): JSONContent {
  if (typeof content === "string") return plainTextToEditorDoc(content);
  return plainTextToEditorDoc(stripImages(content));
}
