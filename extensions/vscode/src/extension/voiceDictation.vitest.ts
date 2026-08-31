import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { createHash } from "crypto";
import type { ChildProcess } from "child_process";
import {
  cancelVoiceRecording,
  assertVoiceTranscriptIsUsable,
  MAX_VOICE_RECORDING_MS,
  PACKAGED_WHISPER_FILES,
  PACKAGED_WHISPER_REVISION,
  parseDirectShowAudioDevices,
  requestRecorderQuit,
  selectDirectShowAudioDevice,
  startVoiceRecording,
  stopVoiceRecording,
  transcribeVoiceFile,
  transcribeDecodedVoiceAudio,
  verifyPackagedWhisperModel,
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

  it.each([
    "[S]",
    " [blank_audio] ",
    "... [NO_SPEECH] ...",
    "<|nospeech|>",
    "( <|NO_SPEECH|> )",
    "[NO-SPEECH]",
    "[NO.SPEECH]",
    "[BLANK-AUDIO]",
    "<|no-speech|>",
  ])("rejects a standalone no-speech marker: %s", (text) => {
    expect(() => assertVoiceTranscriptIsUsable(text, 2)).toThrow(
      "No speech was detected",
    );
  });

  it.each([
    "The no speech setting is disabled",
    "Please remove the [blank_audio] marker from this sentence",
    "S is a normal letter",
  ])("keeps normal text containing marker-like words: %s", (text) => {
    expect(() => assertVoiceTranscriptIsUsable(text, 5)).not.toThrow();
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

  it("selects a real Unicode DirectShow device before a virtual microphone", () => {
    expect(
      selectDirectShowAudioDevice([
        "Микрофон (Steam Streaming Microphone)",
        "Line (4- Steinberg UR22C)",
      ]),
    ).toBe("Line (4- Steinberg UR22C)");
  });

  it.each([
    "VoiceMeeter Output",
    "VB-Audio Virtual Cable",
    "CABLE Output",
    "Stereo Mix (Realtek)",
    "Микрофон (Steam Streaming Microphone)",
  ])("demotes software capture device %s", (software) => {
    expect(
      selectDirectShowAudioDevice([software, "Line (4- Steinberg UR22C)"]),
    ).toBe("Line (4- Steinberg UR22C)");
  });

  it("uses Cukii's packaged/development recorder rather than system PATH", () => {
    expect(voiceFfmpegExecutable()).toMatch(/ffmpeg\.exe$/i);
  });

  it("detects an incomplete packaged model and pins a finite recording cap", () => {
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "cukii-whisper-test-"),
    );
    try {
      const state = verifyPackagedWhisperModel(cacheDir);
      expect(state.valid).toBe(false);
      expect(state.reason).toContain("missing config.json");
      expect(MAX_VOICE_RECORDING_MS).toBe(300_000);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("ships the exact licensed pinned Whisper bytes used by runtime verification", () => {
    const modelDir = path.join(
      __dirname,
      "../../models/whisper-base",
      PACKAGED_WHISPER_REVISION,
    );
    const modelRoot = path.dirname(modelDir);
    expect(PACKAGED_WHISPER_FILES).toEqual({
      "config.json":
        "9d3d599f186a7bca5524326c4164a11a4327d5dce2a47f1e33a8494a0d55cc69",
      "generation_config.json":
        "6f3c718280313752065a69861408eb248e1af08d66c0ca0e214ea571499fc0ea",
      "preprocessor_config.json":
        "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
      "tokenizer_config.json":
        "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce",
      "tokenizer.json":
        "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
      "onnx/decoder_model_merged_quantized.onnx":
        "a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861",
      "onnx/encoder_model_quantized.onnx":
        "3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9",
    });
    for (const [relativePath, expectedHash] of Object.entries(
      PACKAGED_WHISPER_FILES,
    )) {
      expect(
        createHash("sha256")
          .update(fs.readFileSync(path.join(modelDir, relativePath)))
          .digest("hex"),
      ).toBe(expectedHash);
    }
    expect(verifyPackagedWhisperModel(modelDir)).toEqual({ valid: true });
    expect(
      fs.statSync(path.join(modelDir, "onnx/encoder_model_quantized.onnx"))
        .size,
    ).toBeGreaterThan(20_000_000);
    expect(
      fs.readFileSync(path.join(modelRoot, "README.md"), "utf8"),
    ).toContain(
      `Xenova/whisper-base\`\nrevision used by Cukii's offline voice input`,
    );
    expect(fs.readFileSync(path.join(modelRoot, "LICENSE"), "utf8")).toContain(
      "MIT License",
    );
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

  it("enforces one host recording owner across recording identifiers", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-owner-"));
    try {
      await startVoiceRecording("global-owner-one", {
        resolveDevice: async () => "Steinberg",
        spawnRecorder: ((_command: string, args: readonly string[]) =>
          fakeRecorder(String(args.at(-1)))) as any,
        startupDelayMs: 0,
        tempDir,
      });
      await expect(
        startVoiceRecording("global-owner-two", {
          resolveDevice: async () => "Other",
          spawnRecorder: vi.fn() as any,
          startupDelayMs: 0,
          tempDir,
        }),
      ).rejects.toThrow("Another Cukii voice recording is already active");
      await cancelVoiceRecording("global-owner-one");
      await expect(
        startVoiceRecording("global-owner-two", {
          resolveDevice: async () => "Steinberg",
          spawnRecorder: ((_command: string, args: readonly string[]) =>
            fakeRecorder(String(args.at(-1)))) as any,
          startupDelayMs: 0,
          tempDir,
        }),
      ).resolves.toMatchObject({ recordingId: "global-owner-two" });
      await cancelVoiceRecording("global-owner-two");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("kills ffmpeg and removes owned temp files when stdin fails with EIO", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-eio-"));
    const kill = vi.fn();
    try {
      await startVoiceRecording("stdin-eio-test", {
        resolveDevice: async () => "Steinberg",
        spawnRecorder: ((_command: string, args: readonly string[]) => {
          fs.writeFileSync(String(args.at(-1)), Buffer.alloc(64));
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            stderr: new PassThrough(),
            stdin: {
              writable: true,
              write: (_chunk: string, callback: (error: Error) => void) => {
                callback(
                  Object.assign(new Error("device I/O failure"), {
                    code: "EIO",
                  }),
                );
                return false;
              },
            },
            kill: () => {
              kill();
              setImmediate(() => child.emit("exit", 1));
              return true;
            },
          });
          return child;
        }) as any,
        startupDelayMs: 0,
        tempDir,
      });
      await expect(cancelVoiceRecording("stdin-eio-test")).rejects.toThrow(
        "device I/O failure",
      );
      expect(kill).toHaveBeenCalledOnce();
      expect(fs.readdirSync(tempDir)).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("cancels ownership during the pending 450ms start and removes its temp WAV", async () => {
    const recordingId = "pending-start-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-pending-"));
    const sentinel = path.join(tempDir, `cukii-voice-${recordingId}.wav`);
    fs.writeFileSync(sentinel, "do not overwrite");
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
      expect(fs.readFileSync(sentinel, "utf8")).toBe("do not overwrite");
      expect(
        fs
          .readdirSync(tempDir)
          .filter((name) => name.startsWith("cukii-voice-capture-")),
      ).toEqual([]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports and cleans an accepted recorder that exits before stop", async () => {
    const recordingId = "early-exit-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-early-"));
    let child!: ChildProcess;
    try {
      await startVoiceRecording(recordingId, {
        resolveDevice: async () => "Микрофон Steinberg",
        spawnRecorder: ((_command: string, args: readonly string[]) => {
          child = fakeRecorder(String(args.at(-1)));
          return child;
        }) as any,
        startupDelayMs: 0,
        tempDir,
      });
      child.emit("exit", 1);
      expect(voiceRecordingStatus(recordingId)).toEqual({
        state: "error",
        message:
          'The recording device "Микрофон Steinberg" stopped unexpectedly.',
      });
      await vi.waitFor(() =>
        expect(
          fs
            .readdirSync(tempDir)
            .filter((name) => name.startsWith("cukii-voice-capture-")),
        ).toEqual([]),
      );
      await expect(stopVoiceRecording(recordingId)).rejects.toThrow(
        "stopped unexpectedly",
      );
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
