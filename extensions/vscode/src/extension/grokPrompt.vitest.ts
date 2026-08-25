import { describe, expect, it } from "vitest";

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
  it("keeps a compact two-image broker payload under the Windows argv budget", () => {
    const serialized = grokPromptJson(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "look at both screenshots" },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(8_000) } },
            { type: "imageUrl", imageUrl: { url: jpegDataUrl(6_000) } },
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

  it("rejects an attachment that would overflow CreateProcess argv", () => {
    expect(() =>
      grokPromptJson(
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
      ),
    ).toThrow(/too large for the Windows native bridge/);
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
});
