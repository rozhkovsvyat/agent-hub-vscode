import { describe, expect, it } from "vitest";
import { GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS } from "core/cukiiPermissionModes";

import {
  describeBridgeLaunch,
  grokPromptJson,
  MAX_GROK_PROMPT_JSON_BYTES,
} from "./grokPrompt";

function jpegDataUrl(byteLength: number): string {
  const raw = Buffer.alloc(byteLength, 0x41).toString("base64");
  return `data:image/jpeg;base64,${raw}`;
}

describe("grokPromptJson", () => {
  it("carries the latest request inline beside the transcript pointer", () => {
    const serialized = grokPromptJson(
      [
        { role: "user", content: "старая задача" },
        { role: "assistant", content: "сделано" },
        { role: "user", content: "теперь собери новую поставку" },
      ],
      "C:\\tmp\\transcript.txt",
    );

    expect(serialized).toContain("C:\\\\tmp\\\\transcript.txt");
    // The pointer alone made Grok answer from whatever part of the file it
    // read, restarting finished work instead of the turn actually asked.
    expect(serialized).toContain("теперь собери новую поставку");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_GROK_PROMPT_JSON_BYTES,
    );
  });

  it("truncates an oversized latest request on the byte budget", () => {
    const latestText = "Ж".repeat(15_000);
    const serialized = grokPromptJson(
      [{ role: "user", content: latestText }],
      "C:\\tmp\\transcript.txt",
    );

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_GROK_PROMPT_JSON_BYTES,
    );
    expect(serialized).toContain("C:\\\\tmp\\\\transcript.txt");
    // Two bytes per character: a character-wise slice would have overflowed.
    expect(serialized).toContain("Ж");
    expect(serialized).toContain("The rest of this latest turn is in the file.");
  });

  it("does not let a long latest text steal the mixed image budget", () => {
    const serialized = grokPromptJson(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "Ж".repeat(15_000) },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(7_000) } },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(7_000) } },
          ],
        },
      ],
      "C:\\tmp\\transcript.txt",
    );

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_GROK_PROMPT_JSON_BYTES,
    );
    // Images keep first claim on the argv budget; the request text is appended
    // only from what is left, so neither attachment is dropped.
    expect(
      JSON.parse(serialized).filter(
        (block: { type: string }) => block.type === "image",
      ),
    ).toHaveLength(2);
  });

  it("keeps a compact two-image broker payload under the Windows argv budget", () => {
    const serialized = grokPromptJson(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "look at both screenshots" },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(6_500) } },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(5_500) } },
          ],
        },
      ],
      "C:\\tmp\\transcript.txt",
    );

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_GROK_PROMPT_JSON_BYTES,
    );
    const parsed = JSON.parse(serialized);
    expect(
      parsed.filter((block: { type: string }) => block.type === "image"),
    ).toHaveLength(2);
  });

  it("omits an oversized original from argv instead of sending a thumbnail as the picture", () => {
    const serialized = grokPromptJson(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(40_000) } },
          ],
        },
      ],
      "C:\\tmp\\transcript.txt",
    );
    const parsed = JSON.parse(serialized) as Array<{ type: string }>;
    expect(parsed.some((block) => block.type === "image")).toBe(false);
    expect(serialized).toContain("C:\\\\tmp\\\\transcript.txt");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(
      MAX_GROK_PROMPT_JSON_BYTES,
    );
  });

  it("does not inline a 384px preview when the original exceeds the per-image cap", () => {
    const prefix = "data:image/jpeg;base64,";
    const oversizedByOne =
      prefix +
      "A".repeat(GROK_INLINE_ARGV_IMAGE_MAX_DATA_URL_CHARS - prefix.length + 1);
    expect(Buffer.byteLength(oversizedByOne, "utf8")).toBeLessThan(
      MAX_GROK_PROMPT_JSON_BYTES,
    );

    const serialized = grokPromptJson(
      [
        {
          role: "user",
          content: [
            {
              type: "imageUrl",
              imageUrl: {
                url: oversizedByOne,
                inlineArgvUrl: jpegDataUrl(800),
              },
            },
          ],
        },
      ],
      "C:\\tmp\\transcript.txt",
    );
    expect(
      JSON.parse(serialized).some(
        (block: { type: string }) => block.type === "image",
      ),
    ).toBe(false);
  });

  it("canonicalizes image/jpg and rejects SVG at Grok's final boundary", () => {
    const jpeg = grokPromptJson(
      [
        {
          role: "user",
          content: [
            {
              type: "imageUrl",
              imageUrl: { url: "data:image/jpg;base64,aW1hZ2U=" },
            },
          ],
        },
      ],
      "C:\\tmp\\transcript.txt",
    );
    expect(
      JSON.parse(jpeg).find((block: { type: string }) => block.type === "image")
        .mimeType,
    ).toBe("image/jpeg");

    expect(() =>
      grokPromptJson(
        [
          {
            role: "user",
            content: [
              {
                type: "imageUrl",
                imageUrl: { url: "data:image/svg+xml;base64,PHN2Zy8+" },
              },
            ],
          },
        ],
        "C:\\tmp\\transcript.txt",
      ),
    ).toThrow(/JPEG, PNG, GIF, or WebP.*did not drop/i);
  });

  it("rejects remote image URLs instead of silently omitting the attachment", () => {
    expect(() =>
      grokPromptJson(
        [
          {
            role: "user",
            content: [
              {
                type: "imageUrl",
                imageUrl: { url: "https://example.com/screenshot.png" },
              },
            ],
          },
        ],
        "C:\\tmp\\transcript.txt",
      ),
    ).toThrow(/remote image URL.*did not drop/i);
  });

  it("rejects an aggregate overflow without silently dropping later images", () => {
    expect(() =>
      grokPromptJson(
        [
          {
            role: "user",
            content: [
              { type: "imageUrl", imageUrl: { url: jpegDataUrl(7_400) } },
              { type: "imageUrl", imageUrl: { url: jpegDataUrl(7_400) } },
              { type: "imageUrl", imageUrl: { url: jpegDataUrl(7_400) } },
            ],
          },
        ],
        "C:\\tmp\\transcript.txt",
      ),
    ).toThrow(
      /cannot receive 3 image attachments.*Send fewer images or select another broker model.*did not drop any attachment/,
    );
  });

  it("does not replay historical images from earlier turns", () => {
    const serialized = grokPromptJson(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "old" },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(4_000) } },
          ],
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "follow-up without a picture" },
      ],
      "C:\\tmp\\transcript.txt",
    );
    const parsed = JSON.parse(serialized);
    expect(
      parsed.some((block: { type: string }) => block.type === "image"),
    ).toBe(false);
  });
});

describe("describeBridgeLaunch", () => {
  it("redacts --prompt-json so thinking does not dump base64", () => {
    const json = grokPromptJson(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(1_000) } },
          ],
        },
      ],
      "C:\\tmp\\t.txt",
    );
    const line = describeBridgeLaunch("grok.exe", [
      "--model",
      "grok-4.6",
      "--prompt-json",
      json,
      "--always-approve",
    ]);
    expect(line).toContain("--prompt-json");
    expect(line).toMatch(/<\d+ bytes>/);
    expect(line).not.toContain("data:image");
    expect(line).not.toContain(json.slice(0, 40));
  });

  it("redacts Alibaba token-plan secrets if they ever reach argv", () => {
    const line = describeBridgeLaunch("qwen", [
      "--model",
      "qwen3.8-max",
      "sk-sp-should-never-be-logged",
    ]);
    expect(line).toContain("qwen3.8-max");
    expect(line).toContain("sk-sp-[redacted]");
    expect(line).not.toContain("sk-sp-should-never-be-logged");
  });
});
