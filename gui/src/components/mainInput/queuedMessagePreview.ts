import { JSONContent } from "@tiptap/core";

const SPECIAL_BLOCK_TYPES = new Set(["prompt-block", "code-block", "image"]);

function collectText(node: JSONContent | undefined, into: string[]): void {
  if (!node) {
    return;
  }
  if (node.type === "text" && node.text?.trim()) {
    into.push(node.text.trim());
  }
  if (node.type === "mention") {
    const label = node.attrs?.label ?? node.attrs?.id;
    if (typeof label === "string" && label.trim()) {
      into.push(label.trim());
    }
  }
  node.content?.forEach((child) => collectText(child, into));
}

function hasSpecialBlock(node: JSONContent | undefined): boolean {
  if (!node) {
    return false;
  }
  if (node.type && SPECIAL_BLOCK_TYPES.has(node.type)) {
    return true;
  }
  return node.content?.some((child) => hasSpecialBlock(child)) ?? false;
}

export function previewFromEditorJson(json: JSONContent, max = 80): string {
  const texts: string[] = [];
  collectText(json, texts);
  const joined = texts.join(" ").replace(/\s+/g, " ").trim();
  if (joined) {
    return joined.length > max
      ? `${joined.slice(0, Math.max(1, max - 1))}…`
      : joined;
  }
  return hasSpecialBlock(json) ? "Вложение" : "Сообщение";
}
