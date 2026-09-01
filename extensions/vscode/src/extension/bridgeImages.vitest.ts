import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hasImageAttachment, materializeBridgeImages } from "./bridgeImages";

// 1x1 red PNG.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PIXEL}`;

describe("materializeBridgeImages", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-bridge-images-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("turns the newest user image into an @-mention backed by a real file", () => {
    const [message] = materializeBridgeImages(
      [
        {
          role: "user",
          content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        },
      ],
      dir,
    );

    expect(Array.isArray(message.content)).toBe(true);
    const part = (message.content as { type: string; text?: string }[])[0];
    expect(part.type).toBe("text");
    expect(part.text).toMatch(/^@/);
    const referenced = part.text!.slice(1);
    expect(fs.existsSync(referenced)).toBe(true);
    expect(referenced.endsWith(".png")).toBe(true);
    expect(fs.readFileSync(referenced).toString("base64")).toBe(PIXEL);
  });

  it("keeps older turns as plain path references so replays stay cheap", () => {
    const [older] = materializeBridgeImages(
      [
        {
          role: "user",
          content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        },
        { role: "assistant", content: "ok" },
        { role: "user", content: "follow-up without images" },
      ],
      dir,
    );

    const part = (older.content as { type: string; text?: string }[])[0];
    expect(part.text).toMatch(/^\[image saved at /);
    expect(part.text).not.toContain("@");
  });

  it("deduplicates identical attachments across turns", () => {
    materializeBridgeImages(
      [
        {
          role: "user",
          content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        },
        {
          role: "user",
          content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        },
      ],
      dir,
    );

    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it("passes remote URLs through without writing anything", () => {
    const [message] = materializeBridgeImages(
      [
        {
          role: "user",
          content: [
            {
              type: "imageUrl",
              imageUrl: { url: "https://example.com/chart.png" },
            },
          ],
        },
      ],
      dir,
    );

    const part = (message.content as { type: string; text?: string }[])[0];
    expect(part.text).toBe("[image: https://example.com/chart.png]");
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });

  it("falls back to the legacy placeholder for undecodable payloads", () => {
    const [message] = materializeBridgeImages(
      [
        {
          role: "user",
          content: [{ type: "imageUrl", imageUrl: { url: "data:image/x" } }],
        },
      ],
      dir,
    );

    const part = (message.content as { type: string; text?: string }[])[0];
    expect(part.text).toBe("[image attached]");
  });

  it("leaves assistant images and plain strings untouched", () => {
    const messages = materializeBridgeImages(
      [
        {
          role: "assistant",
          content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        },
        { role: "user", content: "just text" },
      ],
      dir,
    );

    expect(messages[0].content).toEqual([
      { type: "imageUrl", imageUrl: { url: DATA_URL } },
    ]);
    expect(messages[1].content).toBe("just text");
    expect(fs.readdirSync(dir)).toHaveLength(0);
  });
});

describe("hasImageAttachment", () => {
  it("detects image parts only where they exist", () => {
    expect(
      hasImageAttachment([
        {
          role: "user",
          content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        },
      ]),
    ).toBe(true);
    expect(hasImageAttachment([{ role: "user", content: "text" }])).toBe(false);
  });
});
