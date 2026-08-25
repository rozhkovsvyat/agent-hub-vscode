import { JSONContent } from "@tiptap/react";
import { stripImages } from "core/util/messageContent";
import { processEditorContent } from "../components/mainInput/TipTapEditor/utils/processEditorContent";

export function isCompactSlashCommand(editorState: JSONContent): boolean {
  const { slashCommandName, parts } = processEditorContent(editorState);

  if (slashCommandName?.toLowerCase() === "compact") {
    return true;
  }

  const text = stripImages(parts).trim();
  return /^\/compact$/i.test(text);
}
