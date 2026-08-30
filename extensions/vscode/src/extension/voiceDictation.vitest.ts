import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import type { ChildProcess } from "child_process";
import {
  cancelVoiceRecording,
  assertVoiceTranscriptIsUsable,
  MAX_VOICE_RECORDING_MS,
  parseDirectShowAudioDevices,
  requestRecorderQuit,
  startVoiceRecording,
  stopVoiceRecording,
  transcribeVoiceFile,
  transcribeDecodedVoiceAudio,
  transcribeWebviewVoiceAudio,
  verifyWhisperCache,
  voiceFfmpegExecutable,
  voiceRecordingStatus,
} from "./voiceDictation";

function fakeRecorder(outputPath: string, exitDelayMs = 0): ChildProcess {
  fs.writeFileSync(outputPath, Buffer.alloc(64));
  const process = new EventEmitter() as ChildProcess;
  const input = new PassThrough();
  const stderr = new PassThrough();
  let exited = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    process.emit("exit", 0);
  };
  input.on("data", () => setTimeout(exit, exitDelayMs));
  Object.assign(process, {
    stdin: input,
    stderr,
    kill: () => {
      setImmediate(exit);
      return true;
    },
  });
  return process;
}

describe("voice dictation runtime", () => {
  it.each([
    ["digital zeros", new Float32Array(16_000)],
    [
      "low-level digital noise",
      Float32Array.from({ length: 16_000 }, (_, index) =>
        index % 2 === 0 ? 5e-5 : -5e-5,
      ),
    ],
  ])(
    "rejects %s before initializing the ASR pipeline",
    async (_name, audio) => {
      let pipelineInitializations = 0;
      await expect(
        transcribeDecodedVoiceAudio(audio, async () => {
          pipelineInitializations += 1;
          throw new Error("pipeline must not initialize");
        }),
      ).rejects.toThrow(
        "No speech was detected. Check the selected microphone and try again.",
      );
      expect(pipelineInitializations).toBe(0);
    },
  );

  it("accepts attenuated speech-like audio and a legitimate repeated phrase", async () => {
    const audio = Float32Array.from(
      { length: 16_000 },
      (_, index) => 0.001 * Math.sin((2 * Math.PI * 220 * index) / 16_000),
    );
    await expect(
      transcribeDecodedVoiceAudio(audio, async () => async () => ({
        text: "да, да, да — всё правильно",
      })),
    ).resolves.toBe("да, да, да — всё правильно");
  });

  it.each([
    Array.from({ length: 150 }, () => "[S]").join(" "),
    "you you you you",
    "[S]".repeat(150),
  ])("rejects degenerate ASR output", (text) => {
    expect(() => assertVoiceTranscriptIsUsable(text, 10)).toThrow(
      "Speech recognition returned repeated text",
    );
  });

  it("extracts DirectShow microphone names", () => {
    const inventory = [
      '[dshow @ 0001] "Line (4- Steinberg UR22C)" (audio)',
      '[dshow @ 0001] "Microphone (Virtual)" (audio)',
    ].join("\n");
    expect(parseDirectShowAudioDevices(inventory)).toEqual([
      "Line (4- Steinberg UR22C)",
      "Microphone (Virtual)",
    ]);
  });

  it("uses Cukii's packaged/development recorder rather than system PATH", () => {
    expect(voiceFfmpegExecutable()).toMatch(/ffmpeg\.exe$/i);
  });

  it("detects a partial Whisper cache and pins a finite recording cap", () => {
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cukii-whisper-test-"),
    );
    try {
      const state = verifyWhisperCache(cacheDir);
      expect(state.valid).toBe(false);
      expect(state.reason).toContain("missing config.json");
      expect(MAX_VOICE_RECORDING_MS).toBe(300_000);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("writes non-empty webview MediaRecorder bytes only for the ASR call and always removes them", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-webview-"));
    const recordingId = "webview-voice-test";
    let receivedPath = "";
    try {
      await expect(
        transcribeWebviewVoiceAudio(
          {
            recordingId,
            audioBase64: Buffer.from("webm-audio").toString("base64"),
            mimeType: "audio/webm;codecs=opus",
            sampleRate: 48_000,
            durationMs: 250,
          },
          async (inputPath) => {
            receivedPath = inputPath;
            expect(fs.readFileSync(inputPath).toString()).toBe("webm-audio");
            return "проверка";
          },
          tempDir,
        ),
      ).resolves.toBe("проверка");
      expect(receivedPath).toMatch(/\.webm$/);
      expect(fs.existsSync(receivedPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["empty bytes", "", "audio/webm", "No microphone audio was captured"],
    ["malformed bytes", "***", "audio/webm", "recording data was invalid"],
    [
      "unsupported mime",
      Buffer.from("a").toString("base64"),
      "text/plain",
      "format is not supported",
    ],
  ])("rejects %s before ASR", async (_name, audioBase64, mimeType, message) => {
    await expect(
      transcribeWebviewVoiceAudio({
        recordingId: "invalid-webview-voice",
        audioBase64,
        mimeType,
        durationMs: 1,
      }),
    ).rejects.toThrow(message);
  });

  it("treats recorder EPIPE during stop as an already-closed microphone", async () => {
    const input = {
      writable: true,
      write: (_chunk: string, callback: (error?: Error) => void) => {
        const error = Object.assign(new Error("closed"), { code: "EPIPE" });
        callback(error);
        return false;
      },
    } as unknown as NodeJS.WritableStream;
    await expect(requestRecorderQuit(input)).resolves.toBeUndefined();
  });

  it("cancels ownership during the pending 450ms start and removes its temp WAV", async () => {
    const recordingId = "pending-start-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-pending-"));
    const outputPath = path.join(tempDir, `cukii-voice-${recordingId}.wav`);
    try {
      const starting = startVoiceRecording(recordingId, {
        resolveDevice: async () => "Test microphone",
        spawnRecorder: ((_command: string, args: readonly string[]) =>
          fakeRecorder(String(args.at(-1)))) as any,
        startupDelayMs: 450,
        tempDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await cancelVoiceRecording(recordingId);
      await expect(starting).rejects.toThrow("cancelled");
      expect(voiceRecordingStatus(recordingId)).toEqual({ state: "unknown" });
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("expires through unified cleanup and exposes a terminal UI contract", async () => {
    const recordingId = "duration-expiry-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-expiry-"));
    const outputPath = path.join(tempDir, `cukii-voice-${recordingId}.wav`);
    try {
      await startVoiceRecording(recordingId, {
        resolveDevice: async () => "Test microphone",
        spawnRecorder: ((_command: string, args: readonly string[]) =>
          fakeRecorder(String(args.at(-1)))) as any,
        startupDelayMs: 0,
        maxDurationMs: 20,
        tempDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(voiceRecordingStatus(recordingId)).toMatchObject({
        state: "expired",
        message: expect.stringContaining("five-minute limit"),
      });
      expect(fs.existsSync(outputPath)).toBe(false);
      await expect(cancelVoiceRecording(recordingId)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects manual stop meaningfully when expiry owns finalization", async () => {
    const recordingId = "stop-expiry-race-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-race-"));
    const outputPath = path.join(tempDir, `cukii-voice-${recordingId}.wav`);
    try {
      await startVoiceRecording(recordingId, {
        resolveDevice: async () => "Test microphone",
        spawnRecorder: ((_command: string, args: readonly string[]) =>
          fakeRecorder(String(args.at(-1)), 40)) as any,
        startupDelayMs: 0,
        maxDurationMs: 10,
        tempDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(stopVoiceRecording(recordingId)).rejects.toThrow(
        "five-minute limit",
      );
      expect(fs.existsSync(outputPath)).toBe(false);
      expect(voiceRecordingStatus(recordingId).state).toBe("expired");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.CUKII_VOICE_CAPTURE)(
    "captures and cancels a real DirectShow microphone session",
    async () => {
      const active = await startVoiceRecording();
      expect(active.device).toBeTruthy();
      await new Promise((resolve) => setTimeout(resolve, 750));
      await expect(
        cancelVoiceRecording(active.recordingId),
      ).resolves.toBeUndefined();
    },
    20_000,
  );

  it.skipIf(!process.env.CUKII_VOICE_FIXTURE)(
    "transcribes a real multilingual WAV with the local Whisper runtime",
    async () => {
      const originalFetch = (globalThis as any).fetch;
      if (process.env.CUKII_WHISPER_OFFLINE === "1") {
        (globalThis as any).fetch = async () => {
          throw new Error("Network access is disabled by the offline proof");
        };
      }
      try {
        const text = await transcribeVoiceFile(
          process.env.CUKII_VOICE_FIXTURE!,
        );
        expect(text.toLocaleLowerCase("ru")).toContain("проверка");
      } finally {
        (globalThis as any).fetch = originalFetch;
      }
    },
    300_000,
  );
});
