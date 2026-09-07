import type { ContextItemWithId } from "core";

export function isFileAttachmentContextItem(item: ContextItemWithId): boolean {
  return (
    item.uri?.type === "file" ||
    item.id.providerTitle === "file" ||
    item.id.providerTitle === "code"
  );
}
