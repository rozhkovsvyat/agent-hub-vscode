import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ChatMessage, MessageContent, MessagePart } from "core";
import { brokerImageCarrierForModel } from "core/cukiiPermissionModes";
import type { BrokerModel } from "core/protocol/ideWebview";
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
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

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
  | { kind: "unsupported" };

function materializeDataUrl(url: string, dir: string): Materialized {
  const matched = url.match(DATA_IMAGE_URL);
  if (!matched) {
    return { kind: "unsupported" };
  }
  const mime = matched[1].toLowerCase();
  const bytes = Buffer.from(matched[2].replace(/\s/g, ""), "base64");
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
  return "[image attached]";
}

export function hasImageAttachment(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "imageUrl"),
  );
}

/**
 * Bind image bytes to the route that will actually carry them. Session
 * history keeps the exact original in `url` so switching vendors cannot
 * destroy detail retroactively; only Grok's one-shot `--prompt-json` route
 * substitutes the bounded alternate immediately before process launch.
 */
export function selectBridgeImageSources(
  messages: ChatMessage[],
  model: BrokerModel,
): ChatMessage[] {
  const carrier = brokerImageCarrierForModel(model);
  return messages.map((message) => {
    if (
      message.role === "system" ||
      message.role === "tool" ||
      typeof message.content === "string"
    ) {
      return message;
    }

    let changed = false;
    const content: MessagePart[] = message.content.map((part) => {
      if (part.type !== "imageUrl") return part;
      changed = true;
      return {
        type: "imageUrl",
        imageUrl: {
          url:
            carrier === "inline-argv"
              ? (part.imageUrl.inlineArgvUrl ?? part.imageUrl.url)
              : part.imageUrl.url,
        },
      };
    });
    return changed ? { ...message, content } : message;
  });
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

/**
 * Materialize one live follow-up for the text-only inbox transport. Image
 * bytes are written exactly as decoded from the original data URL: there is
 * no resize, recompression, re-encoding, or format conversion. The returned
 * text points the native vendor at that original file.
 */
export function materializeBridgeMessageContent(
  content: MessageContent,
  dir: string = bridgeAttachmentDir(),
): string {
  if (typeof content === "string") return content;
  const [message] = materializeBridgeImages([{ role: "user", content }], dir);
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}
