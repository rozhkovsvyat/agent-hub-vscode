import { ChatMessage } from "core";
import { GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS } from "core/cukiiPermissionModes";

import { parseSupportedVisionDataUrl } from "./bridgeImages";

export type GrokPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// Windows CreateProcess limits argv to 32,767 UTF-16 code units. Keep a
// margin for the executable and fixed CLI arguments instead of silently
// dropping the attachment or failing only after the process starts.
export const MAX_GROK_PROMPT_JSON_BYTES = 28_000;

export function grokImageBlock(
  url: string | undefined,
): GrokPromptBlock | undefined {
  if (!url) {
    throw new Error(
      "Grok received an image attachment without a payload. Cukii did not drop the attachment or start the vendor.",
    );
  }
  if (/^https?:\/\//i.test(url)) {
    throw new Error(
      "Grok cannot receive a remote image URL through Windows inline argv. Reattach the image bytes or select another broker model; Cukii did not drop the attachment.",
    );
  }
  const parsed = parseSupportedVisionDataUrl(url);
  if (!parsed) {
    throw new Error(
      "Grok accepts only JPEG, PNG, GIF, or WebP data-URL image attachments. Cukii did not drop the unsupported image.",
    );
  }
  if (url.length > GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS) {
    throw new Error(
      `Grok cannot receive this image attachment in Windows inline argv: ${url.length} characters exceeds the per-image limit ${GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS}. ` +
        "Reattach a smaller image or select another broker model; Cukii did not drop the attachment.",
    );
  }

  return {
    type: "image",
    mimeType: parsed.mimeType,
    data: parsed.data,
  };
}

/**
 * Grok Build accepts image input only through `--prompt-json` content blocks.
 * The textual transcript stays in a private temporary file: this both keeps
 * ordinary long conversations below Windows' argv limit and preserves the
 * exact context that other bridge routes receive.
 */
export function grokPromptJson(
  messages: ChatMessage[],
  transcriptPath: string,
): string {
  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const blocks: GrokPromptBlock[] = [
    {
      type: "text",
      text:
        "Read the complete Cukii broker transcript from this local file before answering: " +
        transcriptPath,
    },
  ];

  // Replaying every historical bitmap makes Windows argv grow without bound;
  // fresh attachments live in the latest user turn. Earlier turns remain in
  // the transcript file as context, and the user can reattach an image when a
  // follow-up needs another visual inspection.
  if (latestUser && Array.isArray(latestUser.content)) {
    for (const part of latestUser.content) {
      if (part.type === "imageUrl") {
        const image = grokImageBlock(part.imageUrl?.url);
        if (image) {
          blocks.push(image);
        }
      }
    }
  }

  const serialized = JSON.stringify(blocks);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes > MAX_GROK_PROMPT_JSON_BYTES) {
    const imageCount = blocks.filter((block) => block.type === "image").length;
    throw new Error(
      `Grok cannot receive ${imageCount} image attachment${imageCount === 1 ? "" : "s"} ` +
        `in one Windows inline-argv request: ${serializedBytes} bytes exceeds ` +
        `${MAX_GROK_PROMPT_JSON_BYTES}. Send fewer images or select another ` +
        "broker model; Cukii did not drop any attachment.",
    );
  }
  return serialized;
}

/** Keep `--prompt-json` bytes out of the thinking card and the launch line. */
export function describeBridgeLaunch(program: string, args: string[]): string {
  const redacted: string[] = [];
  const inlinePromptFlags = new Set(["--prompt-json", "-p", "--prompt"]);
  for (let i = 0; i < args.length; i++) {
    if (inlinePromptFlags.has(args[i]) && i + 1 < args.length) {
      const bytes = Buffer.byteLength(args[i + 1], "utf8");
      redacted.push(args[i], `<${bytes} bytes>`);
      i += 1;
      continue;
    }
    redacted.push(
      args[i]
        .replace(/sk-sp-[A-Za-z0-9._~+/-]+/g, "sk-sp-[redacted]")
        .replace(/sk-[A-Za-z0-9._~+/-]{8,}/g, "sk-[redacted]"),
    );
  }
  return `${program} ${redacted.join(" ")}`;
}
