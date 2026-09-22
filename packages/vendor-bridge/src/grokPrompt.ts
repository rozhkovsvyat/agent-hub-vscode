import { ChatMessage } from "core";
import { GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS } from "core/cukiiPermissionModes";

import { parseSupportedVisionDataUrl } from "./bridgeImages";
import { contentToText } from "./bridgeTranscript";

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
  const pointer =
    "Read the complete Cukii broker transcript from this local file before answering: " +
    transcriptPath;
  const blocks: GrokPromptBlock[] = [{ type: "text", text: pointer }];

  // Replaying every historical bitmap makes Windows argv grow without bound;
  // fresh attachments live in the latest user turn. Earlier turns remain in
  // the transcript file as context, and the user can reattach an image when a
  // follow-up needs another visual inspection.
  //
  // Inline argv may only carry the original bytes when they fit. A 384px
  // transport preview is not the picture the user attached — if the original
  // cannot fit, omit the vision block and keep the transcript @path as the
  // source of truth instead of showing Grok a thumbnail.
  if (latestUser && Array.isArray(latestUser.content)) {
    for (const part of latestUser.content) {
      if (part.type !== "imageUrl") continue;
      const original = part.imageUrl?.url;
      try {
        const image = grokImageBlock(original);
        if (image) blocks.push(image);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (
          !/per-image limit|cannot receive this image attachment/i.test(detail)
        ) {
          throw error;
        }
      }
    }
  }

  // 🔴 The current request must never live only inside the transcript file.
  // When the pointer was the whole prompt, Grok answered from whichever part of
  // that file it happened to read, so it restarted finished work and replied to
  // superseded turns — deterministically, which is why restarting the agent
  // reproduced the same wrong path. Images keep first claim on the Windows argv
  // budget; the verbatim request is appended from whatever remains.
  const latestUserText = latestUser ? contentToText(latestUser.content) : "";
  if (latestUserText.trim()) {
    const preamble =
      "\n\nThe file is the complete briefing. The latest user turn is also " +
      "repeated here so it cannot be missed or confused with an older one:\n\n";
    const truncationNote = "\n[The rest of this latest turn is in the file.]";
    // Measure the payload that actually reaches argv. A raw byte count of the
    // request underestimates it, because JSON escaping expands newlines and
    // quotes after the budget would have been checked.
    const measure = (body: string): number => {
      blocks[0] = { type: "text", text: pointer + preamble + body };
      return Buffer.byteLength(JSON.stringify(blocks), "utf8");
    };
    let keep = latestUserText.length;
    let size = measure(latestUserText);
    while (size > MAX_GROK_PROMPT_JSON_BYTES && keep > 0) {
      // Shrinking a character count by a byte overflow over-trims for Cyrillic
      // rather than under-trimming, so the loop always converges downwards.
      keep = Math.max(0, keep - (size - MAX_GROK_PROMPT_JSON_BYTES) - 64);
      size =
        keep > 0
          ? measure(latestUserText.slice(0, keep) + truncationNote)
          : Number.NaN;
    }
    if (!(keep > 0)) {
      // Attachments alone already fill the budget. Restore the bare pointer so
      // the existing oversized-attachment error still names the real cause.
      blocks[0] = { type: "text", text: pointer };
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
