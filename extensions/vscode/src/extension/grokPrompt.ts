import { ChatMessage } from "core";

import { contentToText } from "./bridgeTranscript";

export type GrokPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const DATA_IMAGE_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

// Windows CreateProcess limits argv to 32,767 UTF-16 code units. Keep a
// margin for the executable and fixed CLI arguments instead of silently
// dropping the attachment or failing only after the process starts.
export const MAX_GROK_PROMPT_JSON_BYTES = 28_000;

export function grokImageBlock(
  url: string | undefined,
): GrokPromptBlock | undefined {
  const matched = url?.match(DATA_IMAGE_URL);
  if (!matched) {
    return undefined;
  }

  return {
    type: "image",
    mimeType: matched[1].toLowerCase(),
    data: matched[2].replace(/\s/g, ""),
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
  const latestText = latestUser ? contentToText(latestUser.content) : "";
  const blocks: GrokPromptBlock[] = [
    {
      type: "text",
      text:
        "Read the complete Cukii broker transcript from this local file before answering: " +
        `${transcriptPath}\n\nLatest user request:\n${latestText}`,
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
  if (Buffer.byteLength(serialized, "utf8") > MAX_GROK_PROMPT_JSON_BYTES) {
    throw new Error(
      "Grok image attachment is too large for the Windows native bridge. " +
        "Attach a smaller image (Broker mode creates compatible attachments automatically).",
    );
  }
  return serialized;
}

/** Keep `--prompt-json` bytes out of the thinking card and the launch line. */
export function describeBridgeLaunch(program: string, args: string[]): string {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt-json" && i + 1 < args.length) {
      const bytes = Buffer.byteLength(args[i + 1], "utf8");
      redacted.push("--prompt-json", `<${bytes} bytes>`);
      i += 1;
      continue;
    }
    redacted.push(args[i]);
  }
  return `${program} ${redacted.join(" ")}`;
}
