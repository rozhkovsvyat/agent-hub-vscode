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
  parseAvFoundationAudioDevices,
  parseMacOSDefaultAudioInput,
  requestRecorderQuit,
  selectDirectShowAudioDevice,
  selectAvFoundationAudioDevice,
  startVoiceRecording,
  stopVoiceRecording,
  transcribeVoiceFile,
  transcribeDecodedVoiceAudio,
  resolveWhisperTranscribeLanguage,
  splitVoiceAudioAtPauses,
  verifyPackagedWhisperModel,
  voiceFfmpegExecutable,
  voiceRecorderArgs,
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

/** A steady 220 Hz "voice" with 0.6 s of silence centred on each pause. */
function speechWithPauses(seconds: number, pauses: number[]): Float32Array {
  return Float32Array.from({ length: seconds * 16_000 }, (_, index) => {
    const t = index / 16_000;
    if (pauses.some((pause) => Math.abs(t - pause) < 0.3)) return 0;
    return 0.05 * Math.sin((2 * Math.PI * 220 * index) / 16_000);
  });
}

/**
 * Three minutes of Russian dictation shaped like the owner's real one in card
 * 364dbc2f (fillers, repeats): as one text it compresses 2.60x, each piece at
 * most 1.67x.
 */
const OWNER_DICTATION_PIECES = [
  "Ну смотри, я сейчас открыл плагин и попробовал надиктовать задачу, вот, и сначала вроде всё нормально, кнопка нажалась, запись пошла.",
  "Потом я говорю, говорю, то есть минуты две, наверное, рассказываю, что надо поправить в настройках, и вот тут уже непонятно, идёт запись или нет.",
  "Вот, и я такой думаю, ладно, нажму стоп, посмотрю, что получится. Нажимаю стоп, и ничего не происходит, вообще ничего, просто тишина.",
  "Ну то есть я не понимаю, он распознаёт или он сломался, вот, никакой индикации, кнопка просто серая, и всё, сиди жди.",
  "Потом вылезает ошибка, что якобы повторяющийся текст, хотя я ничего не повторял, я просто нормально говорил, как обычно говорю.",
  "И самое обидное, что вот всё, что я надиктовал, оно просто пропало, то есть мне теперь надо заново всё это рассказывать.",
  "Вот, а с телефона, если я записываю голосовое и кидаю агенту, оно нормально распознаётся, вот, без всяких проблем, длинное, короткое, любое.",
  "Поэтому я не понимаю, почему тут нельзя сделать так же, вот, ну то есть та же модель, тот же алгоритм, и всё будет работать.",
  "Короче, надо, чтобы было видно, что идёт запись, сколько времени прошло, и чтобы после стопа было видно, что он распознаёт, вот, и чтобы текст не терялся.",
];

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
    [{}, undefined],
    [{ configured: "auto" }, undefined],
    [{ configured: "detect" }, undefined],
    [{ configured: "ru" }, "russian"],
    [{ configured: "ru-RU" }, "russian"],
    [{ configured: "russian" }, "russian"],
    [{ configured: "en" }, "english"],
  ])("resolves Whisper language from %j", (input, expected) => {
    expect(resolveWhisperTranscribeLanguage(input)).toBe(expected);
  });

  it("never forces the VS Code display language onto dictation", () => {
    // Card 364dbc2f: an English UI forced `<|en|>`, and Whisper translated
    // Russian speech into English. `auto` is detection, not the UI language.
    const messenger = fs.readFileSync(
      path.join(__dirname, "VsCodeMessenger.ts"),
      "utf8",
    );
    expect(messenger).not.toMatch(/vscodeLanguage|env\.language/);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"),
    );
    const setting =
      manifest.contributes.configuration.properties["cukii.voiceLanguage"];
    expect(setting.default).toBe("auto");
    expect(setting.markdownDescription).not.toMatch(/display language/i);
  });

  it("passes a configured language and skips detection", async () => {
    const audio = Float32Array.from(
      { length: 16_000 },
      (_, index) => 0.001 * Math.sin((2 * Math.PI * 220 * index) / 16_000),
    );
    let seen: Record<string, unknown> | undefined;
    let detections = 0;
    await expect(
      transcribeDecodedVoiceAudio(
        audio,
        async () => async (_chunk: Float32Array, options: unknown) => {
          seen = options as Record<string, unknown>;
          return { text: "проверка микрофона" };
        },
        {
          language: "russian",
          detectLanguage: async () => {
            detections += 1;
            return "english";
          },
        },
      ),
    ).resolves.toBe("проверка микрофона");
    expect(seen).toEqual({ task: "transcribe", language: "russian" });
    expect(detections).toBe(0);
  });

  it("detects the language once and forces it on every piece", async () => {
    const audio = speechWithPauses(70, [20.5, 45.5]);
    const languages: unknown[] = [];
    let detections = 0;
    const text = await transcribeDecodedVoiceAudio(
      audio,
      async () => async (_piece: Float32Array, options: any) => {
        languages.push(options.language);
        return { text: "кусок диктовки" };
      },
      {
        detectLanguage: async (_recognize, opening) => {
          detections += 1;
          expect(opening.length).toBe(audio.length);
          return "russian";
        },
      },
    );
    expect(detections).toBe(1);
    expect(languages.length).toBeGreaterThan(1);
    expect(new Set(languages)).toEqual(new Set(["russian"]));
    expect(text).toBe(languages.map(() => "кусок диктовки").join(" "));
  });

  it("omits language when detection has no answer", async () => {
    const audio = Float32Array.from(
      { length: 16_000 },
      (_, index) => 0.001 * Math.sin((2 * Math.PI * 220 * index) / 16_000),
    );
    let seen: Record<string, unknown> | undefined;
    await transcribeDecodedVoiceAudio(
      audio,
      async () => async (_chunk: Float32Array, options: unknown) => {
        seen = options as Record<string, unknown>;
        return { text: "hello there" };
      },
      { detectLanguage: async () => undefined },
    );
    expect(seen).toEqual({ task: "transcribe" });
  });

  it("cuts long dictation inside pauses, never past Whisper's window", () => {
    const pauses = [20.5, 45.5, 71];
    const audio = speechWithPauses(90, pauses);
    const segments = splitVoiceAudioAtPauses(audio);
    expect(segments[0][0]).toBe(0);
    expect(segments.at(-1)![1]).toBe(audio.length);
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i][0]).toBe(segments[i - 1][1]);
    }
    for (const [start, end] of segments) {
      expect((end - start) / 16_000).toBeLessThanOrEqual(28);
    }
    const cuts = segments.slice(1).map(([start]) => start / 16_000);
    expect(cuts).toHaveLength(pauses.length);
    cuts.forEach((cut, index) => {
      expect(Math.abs(cut - pauses[index])).toBeLessThan(0.5);
    });
    expect(splitVoiceAudioAtPauses(new Float32Array(16_000 * 10))).toEqual([
      [0, 16_000 * 10],
    ]);
  });

  it("keeps a long real dictation that the old whole-text guard rejected", async () => {
    // A long dictation shaped like the owner's: as one text it compresses
    // past 2.4 and used to be thrown away as "repeated text"; each
    // pause-bounded piece is ordinary speech.
    const pieces = OWNER_DICTATION_PIECES;
    expect(() => assertVoiceTranscriptIsUsable(pieces.join(" "), 188)).toThrow(
      "repeated text",
    );
    let next = 0;
    const text = await transcribeDecodedVoiceAudio(
      speechWithPauses(188, [17.6, 35, 54.7, 81.9, 108.2, 133, 153.3, 172]),
      async () => async () => ({ text: pieces[next++] }),
      { detectLanguage: async () => "russian" },
    );
    expect(next).toBe(pieces.length);
    expect(text).toBe(pieces.join(" "));
  });

  it("drops only the looped piece and keeps the rest of the dictation", async () => {
    const replies = ["первая часть", "R R R R R R R R", "третья часть"];
    let next = 0;
    await expect(
      transcribeDecodedVoiceAudio(
        speechWithPauses(70, [20.5, 45.5]),
        async () => async () => ({ text: replies[next++] }),
        { detectLanguage: async () => "russian" },
      ),
    ).resolves.toBe("первая часть третья часть");

    await expect(
      transcribeDecodedVoiceAudio(
        speechWithPauses(70, [20.5, 45.5]),
        async () => async () => ({ text: "you you you you" }),
        { detectLanguage: async () => "russian" },
      ),
    ).rejects.toThrow("repeated text");
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
    // Sound captions with no words (2.0.172 acceptance: a quiet room).
    "[Birds chirping]",
    "(upbeat music)",
    "[Music] [Applause]",
    "[музыка]",
    " [ Silence ]. ",
  ])("rejects a standalone no-speech marker: %s", (text) => {
    expect(() => assertVoiceTranscriptIsUsable(text, 2)).toThrow(
      "No speech was detected",
    );
  });

  it.each([
    "The no speech setting is disabled",
    "Please remove the [blank_audio] marker from this sentence",
    "S is a normal letter",
    "[Music] and then I said hello",
    "открой файл (тот, что вчера)",
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

  it("extracts only AVFoundation audio devices and selects a physical microphone", () => {
    const inventory = [
      "[AVFoundation indev @ 0x1] AVFoundation video devices:",
      "[AVFoundation indev @ 0x1] [0] FaceTime HD Camera",
      "[AVFoundation indev @ 0x1] AVFoundation audio devices:",
      "[AVFoundation indev @ 0x1] [0] BlackHole 2ch",
      "[AVFoundation indev @ 0x1] [1] MacBook Air Microphone",
    ].join("\n");
    const devices = parseAvFoundationAudioDevices(inventory);
    expect(devices).toEqual([
      { id: "0", label: "BlackHole 2ch" },
      { id: "1", label: "MacBook Air Microphone" },
    ]);
    expect(selectAvFoundationAudioDevice(devices)).toEqual({
      id: "1",
      label: "MacBook Air Microphone",
    });
    expect(selectAvFoundationAudioDevice(devices, "BlackHole 2ch")).toEqual({
      id: "0",
      label: "BlackHole 2ch",
    });
  });

  it("reads the default macOS input selected by CoreAudio", () => {
    expect(
      parseMacOSDefaultAudioInput(
        JSON.stringify({
          SPAudioDataType: [
            {
              _items: [
                { _name: "USB output" },
                {
                  _name: "MacBook Air Microphone",
                  coreaudio_default_audio_input_device: "spaudio_yes",
                },
              ],
            },
          ],
        }),
      ),
    ).toBe("MacBook Air Microphone");
    expect(parseMacOSDefaultAudioInput("not json")).toBeUndefined();
  });

  it("builds native AVFoundation capture argv without DirectShow flags", () => {
    const args = voiceRecorderArgs(
      {
        id: "1",
        label: "MacBook Air Microphone",
        format: "avfoundation",
      },
      "/tmp/recording.wav",
    );
    expect(args).toContain("avfoundation");
    expect(args).toContain(":1");
    expect(args).not.toContain("dshow");
    expect(args).not.toContain("-audio_buffer_size");
    expect(args.slice(-7)).toEqual([
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-y",
      "/tmp/recording.wav",
    ]);
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
    // The bundled recorder is `ffmpeg.exe` on Windows and `ffmpeg` elsewhere;
    // either way it has to be an owned absolute path, never a bare PATH name.
    const executable = voiceFfmpegExecutable();
    expect(executable).toMatch(
      process.platform === "win32" ? /ffmpeg\.exe$/i : /ffmpeg$/i,
    );
    expect(path.isAbsolute(executable)).toBe(true);
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
        "d1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b",
      "generation_config.json":
        "3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05",
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

  /** The WAV a fake recorder writes, wherever the owned capture dir is. */
  function capturedWav(tempDir: string): string | undefined {
    const dir = fs
      .readdirSync(tempDir)
      .find((name) => name.startsWith("cukii-voice-capture-"));
    const wav = dir && path.join(tempDir, dir, "recording.wav");
    return wav && fs.existsSync(wav) ? wav : undefined;
  }

  it("keeps the audio at the five-minute limit and transcribes it on stop", async () => {
    // Card 364dbc2f: the limit used to delete the recording, so a long
    // dictation was simply gone.
    const recordingId = "duration-expiry-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-expiry-"));
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
      const wav = capturedWav(tempDir);
      expect(wav).toBeDefined();
      const seen: string[] = [];
      await expect(
        stopVoiceRecording(recordingId, {
          transcribeFile: async (file) => {
            seen.push(file);
            return "всё, что успел сказать";
          },
        }),
      ).resolves.toBe("всё, что успел сказать");
      expect(seen).toEqual([wav]);
      expect(capturedWav(tempDir)).toBeUndefined();
      expect(voiceRecordingStatus(recordingId).state).toBe("unknown");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("transcribes the kept audio when stop races the limit timer", async () => {
    const recordingId = "stop-expiry-race-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-race-"));
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
      await expect(
        stopVoiceRecording(recordingId, {
          transcribeFile: async () => "до лимита",
        }),
      ).resolves.toBe("до лимита");
      expect(capturedWav(tempDir)).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the audio when transcription fails, so Retry can try again", async () => {
    const recordingId = "kept-after-failure-test";
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-kept-"));
    try {
      await startVoiceRecording(recordingId, {
        resolveDevice: async () => "Test microphone",
        spawnRecorder: ((_command: string, args: readonly string[]) =>
          fakeRecorder(String(args.at(-1)))) as any,
        startupDelayMs: 0,
        tempDir,
      });
      await expect(
        stopVoiceRecording(recordingId, {
          transcribeFile: async () => {
            throw new Error("Speech recognition returned repeated text.");
          },
        }),
      ).rejects.toThrow("The recording is kept: press Retry");
      expect(voiceRecordingStatus(recordingId)).toMatchObject({
        state: "kept",
        message: expect.stringContaining("press Retry"),
      });
      expect(capturedWav(tempDir)).toBeDefined();

      // Retry is the same stop on the same id.
      await expect(
        stopVoiceRecording(recordingId, {
          transcribeFile: async () => "со второй попытки",
        }),
      ).resolves.toBe("со второй попытки");
      expect(capturedWav(tempDir)).toBeUndefined();
      expect(voiceRecordingStatus(recordingId).state).toBe("unknown");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not keep silence and lets cancel discard kept audio", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-discard-"));
    const start = (recordingId: string) =>
      startVoiceRecording(recordingId, {
        resolveDevice: async () => "Test microphone",
        spawnRecorder: ((_command: string, args: readonly string[]) =>
          fakeRecorder(String(args.at(-1)))) as any,
        startupDelayMs: 0,
        tempDir,
      });
    try {
      await start("silent-recording-test");
      await expect(
        stopVoiceRecording("silent-recording-test", {
          transcribeFile: async () => {
            throw new Error(
              "No speech was detected. Check the selected microphone and try again.",
            );
          },
        }),
      ).rejects.toThrow(/^No speech was detected\. Check the selected microphone and try again\.$/);
      expect(capturedWav(tempDir)).toBeUndefined();

      await start("discarded-recording-test");
      await expect(
        stopVoiceRecording("discarded-recording-test", {
          transcribeFile: async () => {
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("press Retry");
      expect(capturedWav(tempDir)).toBeDefined();
      await cancelVoiceRecording("discarded-recording-test");
      expect(capturedWav(tempDir)).toBeUndefined();
      expect(voiceRecordingStatus("discarded-recording-test").state).toBe(
        "unknown",
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.CUKII_VOICE_CAPTURE)(
    "captures and cancels a real platform microphone session",
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
