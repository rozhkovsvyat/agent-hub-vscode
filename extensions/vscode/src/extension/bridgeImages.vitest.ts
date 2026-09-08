import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  markBridgeInboxMessagesRead,
  writeBridgeInboxMessage,
  writeBridgeInboxMessageWithReceipt,
} from "./bridgeInbox";
import {
  BridgeImageScope,
  hasImageAttachment,
  materializeBridgeImages,
  materializeBridgeMessageContent,
  parseSupportedVisionDataUrl,
  selectBridgeImageSources,
} from "./bridgeImages";

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

  it("materializes the image/jpg alias as a jpg without changing bytes", () => {
    const rendered = materializeBridgeMessageContent(
      [
        {
          type: "imageUrl",
          imageUrl: { url: `data:image/jpg;base64,${PIXEL}` },
        },
      ],
      dir,
    );

    expect(rendered).toMatch(/^@.*\.jpg$/);
    expect(fs.readFileSync(rendered.slice(1)).toString("base64")).toBe(PIXEL);
  });

  it("materializes a live inbox follow-up byte-for-byte without resizing or recompression", () => {
    const rendered = materializeBridgeMessageContent(
      [
        { type: "text", text: "inspect this" },
        { type: "imageUrl", imageUrl: { url: DATA_URL } },
      ],
      dir,
    );

    expect(rendered).toMatch(/^inspect this\n@/);
    const referenced = rendered.split("\n@")[1];
    const original = Buffer.from(PIXEL, "base64");
    const stored = fs.readFileSync(referenced);
    expect(stored.equals(original)).toBe(true);
    expect(stored.byteLength).toBe(original.byteLength);
  });

  it("preserves original bytes above the former 20 MiB cutoff", () => {
    const original = Buffer.alloc(20 * 1024 * 1024 + 1, 0xab);
    const rendered = materializeBridgeMessageContent(
      [
        {
          type: "imageUrl",
          imageUrl: {
            url: `data:image/png;base64,${original.toString("base64")}`,
          },
        },
      ],
      dir,
    );

    expect(rendered).toMatch(/^@/);
    const stored = fs.readFileSync(rendered.slice(1));
    expect(stored.byteLength).toBe(original.byteLength);
    expect(stored.equals(original)).toBe(true);
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

  it("repairs a same-size corrupt cache entry before returning its path", () => {
    const first = materializeBridgeMessageContent(
      [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
      dir,
    );
    const referenced = first.slice(1);
    const original = Buffer.from(PIXEL, "base64");
    fs.writeFileSync(referenced, Buffer.alloc(original.byteLength, 0xa5));
    expect(fs.readFileSync(referenced).equals(original)).toBe(false);

    const second = materializeBridgeMessageContent(
      [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
      dir,
    );

    expect(second).toBe(first);
    expect(fs.readFileSync(referenced).equals(original)).toBe(true);
  });

  it("isolates concurrent run scopes until their own lifecycle ends", () => {
    const firstScope = new BridgeImageScope(dir);
    const [firstMessage] = firstScope.materializeMessages([
      {
        role: "user",
        content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
      },
    ]);
    const firstPath = (
      firstMessage.content as Array<{ type: string; text: string }>
    )[0].text.slice(1);
    const olderThanRetention = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(firstScope.directory, olderThanRetention, olderThanRetention);

    const competingContent = Array.from({ length: 257 }, (_, index) => ({
      type: "imageUrl" as const,
      imageUrl: {
        url: `data:image/png;base64,${Buffer.from([
          0xff,
          index >> 8,
          index & 0xff,
        ]).toString("base64")}`,
      },
    }));
    const competingScope = new BridgeImageScope(dir);
    competingScope.materializeMessages([
      { role: "user", content: competingContent },
    ]);

    expect(path.dirname(firstPath)).not.toBe(competingScope.directory);
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(fs.readFileSync(firstPath).toString("base64")).toBe(PIXEL);
    competingScope.dispose();
    expect(fs.existsSync(firstPath)).toBe(true);
    firstScope.dispose();
    expect(fs.existsSync(firstPath)).toBe(false);
  });

  it("retains only inbox image paths and removes cold-start history", () => {
    const scope = new BridgeImageScope(dir);
    const [history] = scope.materializeMessages([
      {
        role: "user",
        content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
      },
    ]);
    const historyPath = (
      history.content as Array<{ type: string; text: string }>
    )[0].text.slice(1);
    let inboxPath = "";

    expect(
      scope.persistInboxMessage(
        [
          {
            type: "imageUrl",
            imageUrl: {
              url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString(
                "base64",
              )}`,
            },
          },
        ],
        (rendered) => {
          inboxPath = rendered.slice(1);
          return true;
        },
      ),
    ).toBe(true);
    expect(path.dirname(inboxPath)).not.toBe(path.dirname(historyPath));

    scope.dispose();

    expect(fs.existsSync(historyPath)).toBe(false);
    expect(fs.existsSync(inboxPath)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(inboxPath), ".released"))).toBe(
      true,
    );
    expect(fs.readdirSync(dir)).toEqual([
      path.basename(path.dirname(inboxPath)),
    ]);
    expect(fs.readdirSync(path.dirname(inboxPath)).sort()).toEqual([
      ".released",
      path.basename(inboxPath),
    ]);
  });

  it("removes inbox image files immediately when the record write fails", () => {
    const scope = new BridgeImageScope(dir);
    const [history] = scope.materializeMessages([
      {
        role: "user",
        content: [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
      },
    ]);
    const historyPath = (
      history.content as Array<{ type: string; text: string }>
    )[0].text.slice(1);
    let rejectedPath = "";

    expect(
      scope.persistInboxMessage(
        [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        (rendered) => {
          rejectedPath = rendered.slice(1);
          return false;
        },
      ),
    ).toBe(false);

    expect(rejectedPath).not.toBe("");
    expect(fs.existsSync(rejectedPath)).toBe(false);
    expect(fs.existsSync(path.dirname(rejectedPath))).toBe(false);
    expect(fs.existsSync(historyPath)).toBe(true);
    scope.dispose();
    expect(fs.existsSync(historyPath)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("prunes an expired released inbox scope without touching live scopes", () => {
    const releasedScope = new BridgeImageScope(dir);
    let releasedPath = "";
    releasedScope.persistInboxMessage(
      [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
      (rendered) => {
        releasedPath = rendered.slice(1);
        return true;
      },
    );
    const releasedDir = path.dirname(releasedPath);
    releasedScope.dispose();
    const marker = path.join(releasedDir, ".released");
    const olderThanRetention = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(marker, olderThanRetention, olderThanRetention);

    const cleanupTrigger = new BridgeImageScope(dir);
    void cleanupTrigger.directory;

    expect(fs.existsSync(releasedDir)).toBe(false);
    cleanupTrigger.dispose();
  });

  it("keeps an expired image scope while its leased inbox record is pending", () => {
    const previousInboxRoot = process.env.CUKII_INBOX_DIR;
    const inboxRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cukii-bridge-image-inbox-"),
    );
    process.env.CUKII_INBOX_DIR = inboxRoot;
    try {
      const scope = new BridgeImageScope(dir);
      let referenced = "";
      expect(
        scope.persistInboxMessage(
          [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
          (rendered) => {
            referenced = rendered.slice(1);
            return writeBridgeInboxMessage(
              "session-1",
              "leased-image",
              rendered,
            );
          },
          { sessionId: "session-1", messageId: "leased-image" },
        ),
      ).toBe(true);
      scope.dispose();
      const marker = path.join(path.dirname(referenced), ".released");
      const olderThanRetention = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      fs.utimesSync(marker, olderThanRetention, olderThanRetention);
      const recordPath = fs
        .readdirSync(path.join(inboxRoot, "session-1"))
        .filter((name) => name.endsWith("-leased-image.json"))
        .map((name) => path.join(inboxRoot, "session-1", name))[0];
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      fs.writeFileSync(
        recordPath,
        JSON.stringify({
          ...record,
          leaseOwner: "reader",
          leasePid: process.pid,
          leaseProcessStartToken: "live",
          leaseUntilMs: Date.now() + 60_000,
        }),
        "utf8",
      );

      const whilePending = new BridgeImageScope(dir);
      void whilePending.directory;
      expect(fs.existsSync(referenced)).toBe(true);
      whilePending.dispose();

      markBridgeInboxMessagesRead("session-1", ["leased-image"]);
      const afterRead = new BridgeImageScope(dir);
      void afterRead.directory;
      expect(fs.existsSync(referenced)).toBe(false);
      afterRead.dispose();
    } finally {
      if (previousInboxRoot === undefined) delete process.env.CUKII_INBOX_DIR;
      else process.env.CUKII_INBOX_DIR = previousInboxRoot;
      fs.rmSync(inboxRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates image retries by original payload and removes retry scopes", () => {
    const previousInboxRoot = process.env.CUKII_INBOX_DIR;
    const inboxRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cukii-bridge-image-retry-"),
    );
    process.env.CUKII_INBOX_DIR = inboxRoot;
    try {
      const scope = new BridgeImageScope(dir);
      const reference = { sessionId: "session-1", messageId: "same-image" };
      const persist = (
        rendered: string,
        metadata?: Parameters<typeof writeBridgeInboxMessageWithReceipt>[3],
      ) =>
        writeBridgeInboxMessageWithReceipt(
          reference.sessionId,
          reference.messageId,
          rendered,
          metadata,
        );
      const content = [
        { type: "imageUrl" as const, imageUrl: { url: DATA_URL } },
      ];

      expect(scope.persistInboxMessage(content, persist, reference)).toBe(true);
      expect(scope.persistInboxMessage(content, persist, reference)).toBe(true);
      expect(
        scope.persistInboxMessage(
          [
            {
              type: "imageUrl",
              imageUrl: {
                url: `data:image/png;base64,${Buffer.from([9, 8, 7]).toString(
                  "base64",
                )}`,
              },
            },
          ],
          persist,
          reference,
        ),
      ).toBe(false);

      expect(fs.readdirSync(dir)).toHaveLength(1);
      const records = fs
        .readdirSync(path.join(inboxRoot, reference.sessionId))
        .filter((name) => name.endsWith(`-${reference.messageId}.json`));
      expect(records).toHaveLength(1);
      const record = JSON.parse(
        fs.readFileSync(
          path.join(inboxRoot, reference.sessionId, records[0]),
          "utf8",
        ),
      );
      expect(record).toMatchObject({
        id: reference.messageId,
        attachmentScope: path.join(
          fs.realpathSync.native(dir),
          fs.readdirSync(dir)[0],
        ),
      });
      const originalScope = record.attachmentScope as string;
      const originalImage = record.text.slice(1) as string;
      expect(fs.existsSync(originalImage)).toBe(true);
      fs.unlinkSync(originalImage);
      expect(fs.existsSync(originalScope)).toBe(true);

      expect(scope.persistInboxMessage(content, persist, reference)).toBe(true);
      const repaired = JSON.parse(
        fs.readFileSync(
          path.join(inboxRoot, reference.sessionId, records[0]),
          "utf8",
        ),
      );
      expect(repaired.attachmentScope).not.toBe(originalScope);
      expect(fs.existsSync(repaired.text.slice(1))).toBe(true);
      expect(fs.existsSync(originalScope)).toBe(false);
      expect(fs.readdirSync(dir)).toHaveLength(1);

      const repairedScope = repaired.attachmentScope as string;
      const repairedImage = repaired.text.slice(1) as string;
      fs.writeFileSync(
        repairedImage,
        Buffer.alloc(fs.statSync(repairedImage).size, 0),
      );
      expect(scope.persistInboxMessage(content, persist, reference)).toBe(true);
      const rehashed = JSON.parse(
        fs.readFileSync(
          path.join(inboxRoot, reference.sessionId, records[0]),
          "utf8",
        ),
      );
      expect(rehashed.attachmentScope).not.toBe(repairedScope);
      expect(fs.existsSync(rehashed.text.slice(1))).toBe(true);
      expect(fs.existsSync(repairedScope)).toBe(false);
      expect(fs.readdirSync(dir)).toHaveLength(1);
      scope.dispose();
    } finally {
      if (previousInboxRoot === undefined) delete process.env.CUKII_INBOX_DIR;
      else process.env.CUKII_INBOX_DIR = previousInboxRoot;
      fs.rmSync(inboxRoot, { recursive: true, force: true });
    }
  });

  it("keeps every path referenced by one prompt above 256 images", () => {
    const content = Array.from({ length: 257 }, (_, index) => ({
      type: "imageUrl" as const,
      imageUrl: {
        url: `data:image/png;base64,${Buffer.from([
          index >> 8,
          index & 0xff,
        ]).toString("base64")}`,
      },
    }));

    const [message] = materializeBridgeImages([{ role: "user", content }], dir);
    const references = (
      message.content as Array<{ type: string; text: string }>
    ).map((part) => part.text.slice(1));

    expect(references).toHaveLength(257);
    expect(references.every((file) => fs.existsSync(file))).toBe(true);
  });

  it("fails closed when original image bytes cannot be written", () => {
    const notADirectory = path.join(dir, "blocked-by-file");
    fs.writeFileSync(notADirectory, "not a directory");

    expect(() =>
      materializeBridgeMessageContent(
        [{ type: "imageUrl", imageUrl: { url: DATA_URL } }],
        notADirectory,
      ),
    ).toThrow(/could not materialize.*silently dropping/i);
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

describe("parseSupportedVisionDataUrl", () => {
  it("canonicalizes image/jpg without changing its payload", () => {
    expect(
      parseSupportedVisionDataUrl(`data:image/jpg;base64,${PIXEL}`),
    ).toEqual({ mimeType: "image/jpeg", data: PIXEL });
  });

  it("rejects SVG at the native vision boundary", () => {
    expect(
      parseSupportedVisionDataUrl("data:image/svg+xml;base64,PHN2Zy8+"),
    ).toBeUndefined();
  });
});

describe("selectBridgeImageSources", () => {
  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "imageUrl" as const,
          imageUrl: {
            url: "data:image/png;base64,original-full-size",
            inlineArgvUrl: "data:image/jpeg;base64,grok-384",
          },
        },
      ],
    },
  ];

  it("keeps the exact original for every out-of-band vendor", () => {
    for (const model of [
      "opus-5",
      "codex-5-6-sol",
      "qwen-3-8-max",
      "kimi-k3",
      "composer-2-5",
    ] as const) {
      const selected = selectBridgeImageSources(messages, model);
      expect(selected[0].content).toEqual([
        {
          type: "imageUrl",
          imageUrl: { url: "data:image/png;base64,original-full-size" },
        },
      ]);
    }
    expect(messages[0].content[0].imageUrl.url).toContain("original-full-size");
  });

  it("substitutes the bounded alternate only for Grok inline argv", () => {
    const selected = selectBridgeImageSources(messages, "grok-4-6");
    expect(selected[0].content).toEqual([
      {
        type: "imageUrl",
        imageUrl: { url: "data:image/jpeg;base64,grok-384" },
      },
    ]);
  });

  it("keeps legacy attachments for final boundary validation", () => {
    const selected = selectBridgeImageSources(
      [
        {
          role: "user",
          content: [
            {
              type: "imageUrl",
              imageUrl: { url: "data:image/jpeg;base64,legacy" },
            },
          ],
        },
      ],
      "grok-4-6",
    );
    expect(selected[0].content).toEqual([
      {
        type: "imageUrl",
        imageUrl: { url: "data:image/jpeg;base64,legacy" },
      },
    ]);
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
