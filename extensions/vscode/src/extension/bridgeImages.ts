import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ChatMessage, MessagePart } from "core";
import { getContinueGlobalPath } from "core/util/paths";

/**
 * Text-only native bridges cannot carry bitmap blocks, so the transcript used
 * to say "[image attached]" and the worker stayed blind. Materialize data-URL
 * attachments on disk instead: the newest user turn becomes an @-mention (CLIs
 * that expand file mentions inline the picture), while older turns keep plain
 * path references so replayed history does not bloat every model request.
 */

const DATA_IMAGE_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

export const MAX_BRIDGE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_STORED_ATTACHMENTS = 256;

export function bridgeAttachmentDir(): string {
  return path.join(getContinueGlobalPath(), "bridge-attachments");
}

function prune(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries.filter((entry) => entry.isFile());
  if (files.length <= MAX_STORED_ATTACHMENTS) {
    return;
  }
  const byMtime = files
    .map((entry) => {
      const full = path.join(dir, entry.name);
      try {
        return { full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .sort((a, b) => a.mtime - b.mtime);
  const excess = byMtime.length - MAX_STORED_ATTACHMENTS;
  for (let index = 0; index < excess; index++) {
    try {
      fs.unlinkSync(byMtime[index].full);
    } catch {
      // Concurrently removed; nothing to clean.
    }
  }
}

type Materialized =
  | { kind: "file"; filePath: string }
  | { kind: "too-large"; megabytes: number }
  | { kind: "unsupported" };

function materializeDataUrl(url: string, dir: string): Materialized {
  const matched = url.match(DATA_IMAGE_URL);
  if (!matched) {
    return { kind: "unsupported" };
  }
  const mime = matched[1].toLowerCase();
  const bytes = Buffer.from(matched[2].replace(/\s/g, ""), "base64");
  if (bytes.length > MAX_BRIDGE_IMAGE_BYTES) {
    return {
      kind: "too-large",
      megabytes: Math.round(bytes.length / (1024 * 1024)),
    };
  }
  const extension = EXTENSION_BY_MIME[mime] ?? ".img";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const filePath = path.join(dir, `${digest}${extension}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, bytes);
      prune(dir);
    }
  } catch {
    return { kind: "unsupported" };
  }
  return { kind: "file", filePath };
}

function renderImageReference(
  url: string | undefined,
  inline: boolean,
  dir: string,
): string {
  if (!url) {
    return "[image attached]";
  }
  if (/^https?:\/\//i.test(url)) {
    return `[image: ${url}]`;
  }
  const materialized = materializeDataUrl(url, dir);
  if (materialized.kind === "file") {
    return inline
      ? `@${materialized.filePath}`
      : `[image saved at ${materialized.filePath}]`;
  }
  if (materialized.kind === "too-large") {
    const limitMb = MAX_BRIDGE_IMAGE_BYTES / (1024 * 1024);
    return `[image omitted: ${materialized.megabytes} MB exceeds the ${limitMb} MB native bridge limit]`;
  }
  return "[image attached]";
}

export function hasImageAttachment(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "imageUrl"),
  );
}

export function materializeBridgeImages(
  messages: ChatMessage[],
  dir: string = bridgeAttachmentDir(),
): ChatMessage[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  return messages.map((message, index) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }
    if (!message.content.some((part) => part.type === "imageUrl")) {
      return message;
    }
    const inline = index === latestUserIndex;
    const content: MessagePart[] = message.content.map((part) =>
      part.type === "imageUrl"
        ? {
            type: "text",
            text: renderImageReference(part.imageUrl?.url, inline, dir),
          }
        : part,
    );
    return { ...message, content };
  });
}
