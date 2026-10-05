import { describe, expect, it } from "vitest";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  WHISPER_SMALL_FILES,
  WHISPER_SMALL_REVISION,
  downloadWhisperSmall,
  resolveVoiceModelChoice,
  verifyModelFiles,
  whisperSmallChoice,
} from "./voiceModelStore";

function tempStorage(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cukii-voice-model-"));
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function streamOf(content: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(content));
      controller.close();
    },
  });
}

describe("verifyModelFiles", () => {
  it("accepts a directory whose files all match their pinned checksums", () => {
    const dir = tempStorage();
    const content = Buffer.from("model bytes");
    fs.writeFileSync(path.join(dir, "config.json"), content);
    fs.mkdirSync(path.join(dir, "onnx"));
    const nested = Buffer.from("encoder");
    fs.writeFileSync(path.join(dir, "onnx", "encoder.onnx"), nested);
    expect(
      verifyModelFiles(dir, {
        "config.json": sha256(content),
        "onnx/encoder.onnx": sha256(nested),
      }),
    ).toEqual({ valid: true });
  });

  it("names the missing file", () => {
    const dir = tempStorage();
    expect(verifyModelFiles(dir, { "config.json": sha256(Buffer.alloc(1)) })).toEqual({
      valid: false,
      reason: "missing config.json",
    });
  });

  it("rejects a file whose content drifted from the pinned checksum", () => {
    const dir = tempStorage();
    fs.writeFileSync(path.join(dir, "config.json"), Buffer.from("tampered"));
    expect(verifyModelFiles(dir, { "config.json": sha256(Buffer.from("original")) })).toEqual({
      valid: false,
      reason: "checksum mismatch for config.json",
    });
  });
});

describe("resolveVoiceModelChoice", () => {
  const valid = () => ({ valid: true as const });
  const invalid = () => ({ valid: false as const, reason: "missing config.json" });

  it("is the packaged base model unless the setting is exactly small", () => {
    const dir = tempStorage();
    for (const setting of [undefined, null, "", "base", "SMALLER", " smallish"]) {
      expect(resolveVoiceModelChoice(setting, dir, valid)).toBeUndefined();
    }
  });

  it("accepts small in any letter case and with surrounding space", () => {
    const dir = tempStorage();
    const choice = resolveVoiceModelChoice("  Small ", dir, valid);
    expect(choice?.id).toBe(`whisper-small/${WHISPER_SMALL_REVISION}`);
    expect(choice?.dir).toBe(
      path.join(dir, "models", "whisper-small", WHISPER_SMALL_REVISION),
    );
    expect(choice?.files).toBe(WHISPER_SMALL_FILES);
  });

  it("falls back to the packaged model while the download is absent or damaged", () => {
    const dir = tempStorage();
    expect(resolveVoiceModelChoice("small", dir, invalid)).toBeUndefined();
  });
});

describe("downloadWhisperSmall", () => {
  it("fails the download and installs nothing when a file misses its checksum", async () => {
    const dir = tempStorage();
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      body: streamOf(Buffer.from("not the pinned bytes")),
    });
    await expect(
      downloadWhisperSmall(dir, { fetchImpl }),
    ).rejects.toThrow(/does not match its pinned checksum/);
    const choice = whisperSmallChoice(dir);
    expect(fs.existsSync(path.join(choice.dir, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(choice.dir, "config.json.part"))).toBe(false);
  });

  it("propagates an HTTP failure with the status and the file", async () => {
    const dir = tempStorage();
    const fetchImpl = async () => ({ ok: false, status: 503, body: null });
    await expect(
      downloadWhisperSmall(dir, { fetchImpl }),
    ).rejects.toThrow(/config\.json failed with HTTP 503/);
  });
});
