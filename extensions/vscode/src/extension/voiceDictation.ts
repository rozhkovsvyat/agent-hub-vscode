import { execFile, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { CUKII_VOICE_SCRATCH_ROOT } from "./vendorBridgeHost";
import {
  createCukiiScratchDirectory,
  removeCukiiScratchDirectory,
} from "@cukii/vendor-bridge";

const execFileAsync = promisify(execFile);

export const PACKAGED_WHISPER_REVISION =
  "64da57285918e20ea79ea5c88eed7197933abaa8";
export const MAX_VOICE_RECORDING_MS = 5 * 60 * 1000;
const WHISPER_MODEL_ROOT = path.join(
  __dirname,
  "models",
  "whisper-base",
  PACKAGED_WHISPER_REVISION,
);
/** SHA-256 of the exact packaged bytes under the pinned Xenova revision. */
export const PACKAGED_WHISPER_FILES: Readonly<Record<string, string>> = {
  // Canonical bytes of the pinned Xenova revision (verified against
  // huggingface.co/Xenova/whisper-base at that exact commit).
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
};

/**
 * Resolves Cukii's recorder, never a machine-global ffmpeg installation.
 * The development fallback makes source-level tests usable before esbuild has
 * populated `out/runtime`; packaged VSIXes use the copied runtime binary.
 */
export function voiceFfmpegExecutable(): string {
  const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const bundled = path.join(__dirname, "runtime", executableName);
  if (fs.existsSync(bundled)) return bundled;

  // Source-level tests run before esbuild has populated out/runtime.
  try {
    const development = createRequire(__filename)("ffmpeg-static") as
      | string
      | null;
    if (development && fs.existsSync(development)) return development;
  } catch {
    // The actionable error below is shared by packaged and development builds.
  }
  throw new Error(
    "Cukii's bundled audio recorder is missing. Reinstall Cukii.",
  );
}

type Recording = {
  process: ChildProcess;
  ownedDir: string;
  outputPath: string;
  device: string;
  platform: NodeJS.Platform;
  exited?: { code: number | null; stderr: string };
  failure?: Error;
  durationTimer?: NodeJS.Timeout;
  cleanupOwnedDir: () => void;
};

const recordings = new Map<string, Recording>();
let recordingOwner: string | undefined;
const pendingRecordings = new Set<string>();
const cancelledStarts = new Set<string>();
const finalizations = new Map<string, Promise<string | void>>();
const terminalRecordings = new Map<
  string,
  { state: "expired" | "error"; message: string; cleanup: NodeJS.Timeout }
>();
/**
 * Audio the recorder already finished but no transcript has been delivered
 * for: the five-minute limit, or a transcription that failed. It used to be
 * deleted on the spot, so a long dictation was lost to one recognition error
 * (card 364dbc2f). `stopVoiceRecording` on the same id transcribes it again.
 */
type KeptRecording = {
  state: "expired" | "kept";
  message: string;
  outputPath: string;
  cleanupOwnedDir: () => void;
  cleanup: NodeJS.Timeout;
};
const keptRecordings = new Map<string, KeptRecording>();
const KEPT_RECORDING_TTL_MS = 30 * 60 * 1000;
const EXPIRED_MESSAGE =
  "Voice recording reached the five-minute limit. Transcribing what was recorded…";
const KEPT_SUFFIX = " The recording is kept: press Retry to transcribe it again.";
let transcriberPromise: Promise<any> | undefined;

type VoiceRecordingOptions = {
  resolveDevice?: () => Promise<string | VoiceCaptureDevice>;
  spawnRecorder?: typeof spawn;
  startupDelayMs?: number;
  maxDurationMs?: number;
  tempDir?: string;
  platform?: NodeJS.Platform;
};

export type VoiceCaptureDevice = {
  id: string;
  label: string;
  format: "dshow" | "avfoundation";
};

export function verifyPackagedWhisperModel(modelDir = WHISPER_MODEL_ROOT): {
  valid: boolean;
  reason?: string;
} {
  for (const [relativePath, expectedHash] of Object.entries(
    PACKAGED_WHISPER_FILES,
  )) {
    const filePath = path.join(modelDir, ...relativePath.split("/"));
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: `missing ${relativePath}` };
    }
    const digest = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    if (digest !== expectedHash) {
      return { valid: false, reason: `checksum mismatch for ${relativePath}` };
    }
  }
  return { valid: true };
}

export function parseDirectShowAudioDevices(stderr: string): string[] {
  return [...stderr.matchAll(/"([^"]+)"\s+\(audio\)/g)].map(
    (match) => match[1],
  );
}

export function selectDirectShowAudioDevice(
  devices: string[],
): string | undefined {
  const softwareDevice =
    /streaming|virtual|voicemeeter|vb[- ]?audio|cable|stereo mix|стерео микшер|blackhole|soundflower|loopback/i;
  return devices.find((device) => !softwareDevice.test(device)) ?? devices[0];
}

export function parseAvFoundationAudioDevices(
  stderr: string,
): Array<{ id: string; label: string }> {
  const devices: Array<{ id: string; label: string }> = [];
  let inAudioSection = false;
  for (const line of stderr.split(/\r?\n/u)) {
    if (/AVFoundation audio devices:/iu.test(line)) {
      inAudioSection = true;
      continue;
    }
    if (/AVFoundation video devices:/iu.test(line)) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) continue;
    const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/u);
    if (match) devices.push({ id: match[1], label: match[2] });
  }
  return devices;
}

export function selectAvFoundationAudioDevice(
  devices: Array<{ id: string; label: string }>,
  defaultInputLabel?: string,
): { id: string; label: string } | undefined {
  if (defaultInputLabel) {
    const defaultDevice = devices.find(
      (device) => device.label === defaultInputLabel,
    );
    if (defaultDevice) return defaultDevice;
  }
  const labels = devices.map((device) => device.label);
  const selected = selectDirectShowAudioDevice(labels);
  return devices.find((device) => device.label === selected) ?? devices[0];
}

export function parseMacOSDefaultAudioInput(
  stdout: string,
): string | undefined {
  try {
    const report = JSON.parse(stdout) as {
      SPAudioDataType?: Array<{
        _items?: Array<Record<string, unknown>>;
      }>;
    };
    return report.SPAudioDataType?.flatMap((group) => group._items ?? []).find(
      (device) =>
        device.coreaudio_default_audio_input_device === "spaudio_yes" &&
        typeof device._name === "string",
    )?._name as string | undefined;
  } catch {
    return undefined;
  }
}

export function voiceRecorderArgs(
  device: VoiceCaptureDevice,
  outputPath: string,
): string[] {
  const input =
    device.format === "avfoundation"
      ? ["-f", "avfoundation", "-i", `:${device.id}`]
      : ["-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${device.id}`];
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...input,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    "-y",
    outputPath,
  ];
}

async function audioDevice(
  platform: NodeJS.Platform = process.platform,
): Promise<VoiceCaptureDevice> {
  if (platform !== "win32" && platform !== "darwin") {
    throw new Error(
      "Voice input is currently available on Windows and macOS only. Cukii needs a platform recorder for this operating system.",
    );
  }
  const ffmpeg = voiceFfmpegExecutable();
  let stderr = "";
  try {
    const result = await execFileAsync(
      ffmpeg,
      platform === "darwin"
        ? [
            "-hide_banner",
            "-f",
            "avfoundation",
            "-list_devices",
            "true",
            "-i",
            "",
          ]
        : [
            "-hide_banner",
            "-f",
            "dshow",
            "-list_devices",
            "true",
            "-i",
            "dummy",
          ],
      { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    stderr = String(result.stderr ?? "");
  } catch (error) {
    stderr = String((error as { stderr?: unknown }).stderr ?? "");
  }
  if (platform === "darwin") {
    let defaultInputLabel: string | undefined;
    try {
      const profile = await execFileAsync(
        "/usr/sbin/system_profiler",
        ["SPAudioDataType", "-json"],
        { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
      );
      defaultInputLabel = parseMacOSDefaultAudioInput(
        String(profile.stdout ?? ""),
      );
    } catch {
      // AVFoundation inventory remains the authoritative fallback when the
      // optional system profile cannot be queried.
    }
    const selected = selectAvFoundationAudioDevice(
      parseAvFoundationAudioDevices(stderr),
      defaultInputLabel,
    );
    if (!selected) {
      throw new Error(
        "No macOS recording device was found. Open System Settings → Privacy & Security → Microphone and allow Visual Studio Code/Cukii, then retry.",
      );
    }
    return { ...selected, format: "avfoundation" };
  }
  const devices = parseDirectShowAudioDevices(stderr);
  const selected = selectDirectShowAudioDevice(devices);
  if (!selected) {
    throw new Error("No Windows recording device was found.");
  }
  return { id: selected, label: selected, format: "dshow" };
}

async function waitForRecorderStart(
  recording: Recording,
  startupDelayMs: number,
  isCancelled: () => boolean,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
  if (isCancelled()) throw new Error("Voice recording was cancelled.");
  if (recording.exited) {
    const stderr = recording.exited.stderr.trim();
    if (
      recording.platform === "darwin" &&
      /(?:not authorized|operation not permitted|permission denied|failed to create av capture input|cannot open audio device)/iu.test(
        stderr,
      )
    ) {
      throw new Error(
        "macOS denied microphone access. Open System Settings → Privacy & Security → Microphone, allow Visual Studio Code/Cukii, then retry.",
      );
    }
    throw new Error(
      stderr ||
        `The recording device "${recording.device}" could not be opened.`,
    );
  }
  if (recording.failure) throw recording.failure;
}

export async function startVoiceRecording(
  recordingId: string = randomUUID(),
  options: VoiceRecordingOptions = {},
): Promise<{
  recordingId: string;
  device: string;
}> {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(recordingId)) {
    throw new Error("Invalid voice recording identifier.");
  }
  if (pendingRecordings.has(recordingId) || recordings.has(recordingId)) {
    throw new Error("Voice recording is already active.");
  }
  if (recordingOwner) {
    throw new Error("Another Cukii voice recording is already active.");
  }
  recordingOwner = recordingId;
  pendingRecordings.add(recordingId);
  let ownedDir: string | undefined;
  let cleanupOwnedDir: (() => void) | undefined;
  try {
    const platform = options.platform ?? process.platform;
    const resolvedDevice = await (
      options.resolveDevice ?? (() => audioDevice(platform))
    )();
    const device: VoiceCaptureDevice =
      typeof resolvedDevice === "string"
        ? {
            id: resolvedDevice,
            label: resolvedDevice,
            format: platform === "darwin" ? "avfoundation" : "dshow",
          }
        : resolvedDevice;
    if (cancelledStarts.delete(recordingId)) {
      throw new Error("Voice recording was cancelled.");
    }
    const isTestDirectory = options.tempDir !== undefined;
    ownedDir = isTestDirectory
      ? fs.mkdtempSync(path.join(options.tempDir!, "cukii-voice-capture-"))
      : createCukiiScratchDirectory(CUKII_VOICE_SCRATCH_ROOT, "voice-capture");
    const cleanup = isTestDirectory
      ? () => fs.rmSync(ownedDir!, { recursive: true, force: true })
      : () => removeCukiiScratchDirectory(ownedDir!, CUKII_VOICE_SCRATCH_ROOT);
    cleanupOwnedDir = cleanup;
    const outputPath = path.join(ownedDir, "recording.wav");
    const child = (options.spawnRecorder ?? spawn)(
      voiceFfmpegExecutable(),
      voiceRecorderArgs(device, outputPath),
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    const recording: Recording = {
      process: child,
      ownedDir,
      outputPath,
      device: device.label,
      platform,
      cleanupOwnedDir: cleanup,
    };
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => {
      recording.exited = { code, stderr };
    });
    child.on("error", (error) => {
      recording.failure = error;
    });
    recordings.set(recordingId, recording);
    recording.durationTimer = setTimeout(() => {
      void finalizeRecording(recordingId, "expire").catch((error) => {
        rememberTerminal(recordingId, "error", voiceError(error).message);
      });
    }, options.maxDurationMs ?? MAX_VOICE_RECORDING_MS);
    recording.durationTimer.unref();
    await waitForRecorderStart(
      recording,
      options.startupDelayMs ?? 450,
      () => cancelledStarts.has(recordingId) || !recordings.has(recordingId),
    );
    if (cancelledStarts.delete(recordingId) || !recordings.has(recordingId)) {
      throw new Error("Voice recording was cancelled.");
    }
    return { recordingId, device: device.label };
  } catch (error) {
    if (recordings.has(recordingId)) {
      await finalizeRecording(recordingId, "cancel");
    } else if (ownedDir) {
      cleanupOwnedDir?.();
    }
    throw error;
  } finally {
    pendingRecordings.delete(recordingId);
    cancelledStarts.delete(recordingId);
    if (!recordings.has(recordingId) && recordingOwner === recordingId) {
      recordingOwner = undefined;
    }
  }
}

async function stopRecorder(recording: Recording): Promise<void> {
  if (recording.durationTimer) clearTimeout(recording.durationTimer);
  if (recording.exited) return;
  let quitError: unknown;
  try {
    await requestRecorderQuit(recording.process.stdin);
  } catch (error) {
    quitError = error;
  }
  const gracefulWaitMs = recording.platform === "darwin" ? 750 : 5_000;
  if (!quitError && (await waitForProcessExit(recording, gracefulWaitMs))) {
    return;
  }
  if (!recording.exited) {
    recording.process.kill(
      recording.platform === "darwin" ? "SIGINT" : "SIGTERM",
    );
  }
  if (!recording.exited && (await waitForProcessExit(recording, 2_000))) {
    if (quitError) throw quitError;
    return;
  }
  if (!recording.exited) recording.process.kill("SIGTERM");
  if (!recording.exited && (await waitForProcessExit(recording, 1_000))) {
    if (quitError) throw quitError;
    return;
  }
  if (!recording.exited) recording.process.kill("SIGKILL");
  if (!recording.exited && !(await waitForProcessExit(recording, 1_000))) {
    throw new Error("The audio recorder did not stop after termination.");
  }
  if (quitError) throw quitError;
}

export async function requestRecorderQuit(
  input: NodeJS.WritableStream | null | undefined,
): Promise<void> {
  if (!input || !input.writable) return;
  await new Promise<void>((resolve, reject) => {
    input.write("q\n", (error?: Error | null) => {
      if (!error || (error as NodeJS.ErrnoException).code === "EPIPE")
        resolve();
      else reject(error);
    });
  });
}

async function waitForProcessExit(
  recording: Recording,
  timeoutMs: number,
): Promise<boolean> {
  if (recording.exited) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    recording.process.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function voiceError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function createTranscriber(): Promise<any> {
  const modelState = verifyPackagedWhisperModel();
  if (!modelState.valid) {
    throw new Error(
      `Cukii's packaged Whisper model failed integrity verification: ${modelState.reason}. Reinstall Cukii.`,
    );
  }
  const { env, pipeline } = await import("@xenova/transformers");
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = path.join(__dirname, "models");
  env.useFSCache = false;
  env.useBrowserCache = false;
  return pipeline(
    "automatic-speech-recognition",
    `whisper-base/${PACKAGED_WHISPER_REVISION}`,
    { local_files_only: true },
  );
}

async function transcriber(): Promise<any> {
  if (!transcriberPromise) {
    transcriberPromise = createTranscriber().catch((error) => {
      transcriberPromise = undefined;
      throw voiceError(error);
    });
  }
  return transcriberPromise;
}

/** Decode every supported WAV/recording to Whisper's required mono 16k Float32. */
async function decodeVoiceAudio(inputPath: string): Promise<Float32Array> {
  const { stdout } = (await execFileAsync(
    voiceFfmpegExecutable(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    {
      windowsHide: true,
      encoding: "buffer" as any,
      maxBuffer: 512 * 1024 * 1024,
    },
  )) as unknown as { stdout: Buffer };
  if (stdout.byteLength === 0) {
    throw new Error("No audio stream was found in the voice recording.");
  }
  const aligned = stdout.subarray(
    0,
    stdout.byteLength - (stdout.byteLength % 4),
  );
  return new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    aligned.byteLength / 4,
  ).slice();
}

const NO_SPEECH_MESSAGE =
  "No speech was detected. Check the selected microphone and try again.";

export function assertVoiceAudioHasSpeech(audio: Float32Array): void {
  let peak = 0;
  let squareSum = 0;
  for (const sample of audio) {
    const amplitude = Math.abs(sample);
    if (amplitude > peak) peak = amplitude;
    squareSum += sample * sample;
  }
  const rms = audio.length > 0 ? Math.sqrt(squareSum / audio.length) : 0;
  if (peak < 5e-4 && rms < 1e-4) throw new Error(NO_SPEECH_MESSAGE);
}

const REPEATED_TEXT_MESSAGE =
  "Speech recognition returned repeated text. Check the selected microphone and try again.";

export function assertVoiceTranscriptIsUsable(
  text: string,
  durationSeconds: number,
): void {
  const problem = voiceTranscriptProblem(text, durationSeconds);
  if (problem === "no-speech") throw new Error(NO_SPEECH_MESSAGE);
  if (problem === "repeated") throw new Error(REPEATED_TEXT_MESSAGE);
}

/**
 * Whisper's own hallucination limits (compression ratio 2.4 and friends) are
 * defined per ~30 s decoding window. Applied to a whole long dictation they
 * reject ordinary speech: the owner's real 111 s Russian dictation already
 * compresses 2.45x (card 364dbc2f). Callers pass one pause-bounded segment.
 */
export function voiceTranscriptProblem(
  text: string,
  durationSeconds: number,
): "no-speech" | "repeated" | undefined {
  const canonical = text
    .trim()
    .toLocaleLowerCase()
    .replace(/^[\s"'`.,!?;:(){}-]+|[\s"'`.,!?;:(){}-]+$/gu, "")
    .replace(/[.-]/g, "_")
    .replace(/\s+/g, "");
  if (
    new Set([
      "[s]",
      "[blank_audio]",
      "[no_speech]",
      "<|nospeech|>",
      "<|no_speech|>",
    ]).has(canonical) ||
    // Whisper captions sound it cannot read as speech: "[Birds chirping]",
    // "(upbeat music)", "[музыка]". A piece made only of such captions has
    // no words; the 2.0.172 acceptance inserted "[Birds chirping]" from a
    // quiet room. Words around a bracket are speech and stay; a long run of
    // one caption is a decoding loop and stays "repeated".
    /^(?:\s*(?:\[[^\[\]]{1,60}\]|\([^()]{1,60}\))[\s.,!?…-]*){1,3}$/u.test(text)
  ) {
    return "no-speech";
  }
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const normalized = tokens.map((token) =>
    token.toLocaleLowerCase().replace(/[^\p{L}\p{N}\[\]]/gu, ""),
  );
  const counts = new Map<string, number>();
  let longestConsecutive = 0;
  let consecutive = 0;
  let previous = "";
  for (const token of normalized) {
    if (!token) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
    if (token === previous) consecutive += 1;
    else consecutive = 1;
    previous = token;
    longestConsecutive = Math.max(longestConsecutive, consecutive);
  }
  const dominant = Math.max(0, ...counts.values());
  const dominantRatio = tokens.length > 0 ? dominant / tokens.length : 0;
  const bytes = Buffer.from(text, "utf8");
  const compressionRatio =
    bytes.length >= 100 ? bytes.length / gzipSync(bytes).byteLength : 0;
  const outputRateTooHigh =
    tokens.length > Math.max(24, Math.max(0, durationSeconds) * 8);
  if (
    (tokens.length >= 8 && dominantRatio >= 0.65) ||
    longestConsecutive >= 4 ||
    compressionRatio > 2.4 ||
    outputRateTooHigh
  ) {
    return "repeated";
  }
  return undefined;
}

const VOICE_SAMPLE_RATE = 16_000;
/** Whisper decodes at most 30 s at once; a margin keeps every cut inside it. */
const MAX_VOICE_SEGMENT_SECONDS = 28;
const PAUSE_FRAME_SAMPLES = 480; // 30 ms
const PAUSE_WINDOW_FRAMES = 5; // ±150 ms around a candidate cut

/**
 * Splits a dictation into independent pieces of at most `maxSeconds`, cutting
 * at the quietest 300 ms in the last 40% of each piece, so a cut lands in a
 * pause between words. Long dictation used to go through the pipeline's own
 * 30 s / 5 s stride windows, whose merge dropped most of the first half
 * minute of a real 188 s recording (123 words left of 318) or looped on
 * "R R R"; pause-bounded pieces gave 307 (card 364dbc2f).
 */
export function splitVoiceAudioAtPauses(
  audio: Float32Array,
  maxSeconds = MAX_VOICE_SEGMENT_SECONDS,
  sampleRate = VOICE_SAMPLE_RATE,
): Array<[number, number]> {
  const maxSamples = Math.floor(maxSeconds * sampleRate);
  if (audio.length <= maxSamples) return [[0, audio.length]];
  const frames = Math.floor(audio.length / PAUSE_FRAME_SAMPLES);
  const energy = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    const offset = frame * PAUSE_FRAME_SAMPLES;
    for (let i = offset; i < offset + PAUSE_FRAME_SAMPLES; i++) {
      sum += audio[i] * audio[i];
    }
    energy[frame] = sum;
  }
  const maxFrames = Math.floor(maxSamples / PAUSE_FRAME_SAMPLES);
  const segments: Array<[number, number]> = [];
  let start = 0;
  while (audio.length - start * PAUSE_FRAME_SAMPLES > maxSamples) {
    let cut = start + maxFrames;
    let quietest = Infinity;
    for (
      let frame = start + Math.floor(maxFrames * 0.6);
      frame < start + maxFrames;
      frame++
    ) {
      let around = 0;
      for (
        let k = frame - PAUSE_WINDOW_FRAMES;
        k <= frame + PAUSE_WINDOW_FRAMES;
        k++
      ) {
        around += energy[k] ?? 0;
      }
      if (around < quietest) {
        quietest = around;
        cut = frame;
      }
    }
    segments.push([start * PAUSE_FRAME_SAMPLES, cut * PAUSE_FRAME_SAMPLES]);
    start = cut;
  }
  segments.push([start * PAUSE_FRAME_SAMPLES, audio.length]);
  return segments;
}

/**
 * Whisper's language identification: one decoder step on the opening audio,
 * argmax over the language tokens only. transformers.js 2.14 does not return
 * the language its pipeline picked, and the unrestricted argmax at that
 * position is `<|nocaptions|>`. Undefined when the recognizer is not the real
 * pipeline or detection fails; each piece then detects on its own.
 */
export async function detectSpokenLanguage(
  recognize: any,
  audio: Float32Array,
): Promise<string | undefined> {
  const vocabulary: Map<string, number> | undefined =
    recognize?.tokenizer?.model?.tokens_to_ids;
  if (!vocabulary || !recognize?.processor || !recognize?.model?.generate) {
    return undefined;
  }
  try {
    const languageByToken = new Map<number, string>();
    for (const [code, name] of Object.entries(WHISPER_LANGUAGE_BY_CODE)) {
      const id = vocabulary.get(`<|${code}|>`);
      if (id !== undefined) languageByToken.set(id, name);
    }
    const transcribeToken = vocabulary.get("<|transcribe|>");
    if (languageByToken.size === 0 || transcribeToken === undefined) {
      return undefined;
    }
    const { input_features } = await recognize.processor(
      audio.subarray(0, Math.min(audio.length, 30 * VOICE_SAMPLE_RATE)),
    );
    const onlyLanguages = (_ids: unknown, logits: { data: Float32Array }) => {
      const data = logits.data;
      for (let i = 0; i < data.length; i++) {
        if (!languageByToken.has(i)) data[i] = -Infinity;
      }
      return logits;
    };
    const output = await recognize.model.generate(
      input_features,
      {
        max_new_tokens: 1,
        // Position 1 stays free for the language; 2.14 needs one forced id.
        forced_decoder_ids: [[2, transcribeToken]],
        return_timestamps: false,
        suppress_tokens: null,
        begin_suppress_tokens: null,
      },
      [onlyLanguages],
    );
    const ids = Array.from((output?.[0] ?? output) as ArrayLike<unknown>, Number);
    return languageByToken.get(ids[ids.length - 1]);
  } catch {
    return undefined;
  }
}

export type WhisperLanguageSource = {
  configured?: string | null;
};

/**
 * Forcing a language token makes Whisper TRANSLATE speech in another language
 * into it. `auto` used to force the VS Code display language, so with an
 * English UI every Russian dictation came back as English text (card
 * 364dbc2f). `auto` now means detection (`detectSpokenLanguage`), which named
 * Russian correctly even on 3–4 s clips; a configured language still wins.
 */
const WHISPER_LANGUAGE_BY_CODE: Readonly<Record<string, string>> = {
  af: "afrikaans",
  am: "amharic",
  ar: "arabic",
  as: "assamese",
  az: "azerbaijani",
  ba: "bashkir",
  be: "belarusian",
  bg: "bulgarian",
  bn: "bengali",
  bo: "tibetan",
  br: "breton",
  bs: "bosnian",
  ca: "catalan",
  cs: "czech",
  cy: "welsh",
  da: "danish",
  de: "german",
  el: "greek",
  en: "english",
  es: "spanish",
  et: "estonian",
  eu: "basque",
  fa: "persian",
  fi: "finnish",
  fo: "faroese",
  fr: "french",
  gl: "galician",
  gu: "gujarati",
  ha: "hausa",
  haw: "hawaiian",
  he: "hebrew",
  hi: "hindi",
  hr: "croatian",
  ht: "haitian creole",
  hu: "hungarian",
  hy: "armenian",
  id: "indonesian",
  is: "icelandic",
  it: "italian",
  ja: "japanese",
  jw: "javanese",
  ka: "georgian",
  kk: "kazakh",
  km: "khmer",
  kn: "kannada",
  ko: "korean",
  la: "latin",
  lb: "luxembourgish",
  ln: "lingala",
  lo: "lao",
  lt: "lithuanian",
  lv: "latvian",
  mg: "malagasy",
  mi: "maori",
  mk: "macedonian",
  ml: "malayalam",
  mn: "mongolian",
  mr: "marathi",
  ms: "malay",
  mt: "maltese",
  my: "myanmar",
  ne: "nepali",
  nl: "dutch",
  nn: "nynorsk",
  no: "norwegian",
  oc: "occitan",
  pa: "punjabi",
  pl: "polish",
  ps: "pashto",
  pt: "portuguese",
  ro: "romanian",
  ru: "russian",
  sa: "sanskrit",
  sd: "sindhi",
  si: "sinhala",
  sk: "slovak",
  sl: "slovenian",
  sn: "shona",
  so: "somali",
  sq: "albanian",
  sr: "serbian",
  su: "sundanese",
  sv: "swedish",
  sw: "swahili",
  ta: "tamil",
  te: "telugu",
  tg: "tajik",
  th: "thai",
  tk: "turkmen",
  tl: "tagalog",
  tr: "turkish",
  tt: "tatar",
  uk: "ukrainian",
  ur: "urdu",
  uz: "uzbek",
  vi: "vietnamese",
  yi: "yiddish",
  yo: "yoruba",
  zh: "chinese",
};

const WHISPER_LANGUAGE_BY_NAME: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.values(WHISPER_LANGUAGE_BY_CODE).map((name) => [name, name]),
  );

export function resolveWhisperTranscribeLanguage(
  source: WhisperLanguageSource = {},
): string | undefined {
  return canonicalWhisperLanguage(source.configured);
}

function canonicalWhisperLanguage(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (
    !normalized ||
    normalized === "auto" ||
    normalized === "detect" ||
    normalized === "none"
  ) {
    return undefined;
  }
  if (WHISPER_LANGUAGE_BY_NAME[normalized]) {
    return WHISPER_LANGUAGE_BY_NAME[normalized];
  }
  const code = normalized.split("-")[0] ?? "";
  return WHISPER_LANGUAGE_BY_CODE[code];
}

export type VoiceTranscribeOptions = {
  language?: string;
  detectLanguage?: (
    recognize: any,
    audio: Float32Array,
  ) => Promise<string | undefined>;
};

export async function transcribeDecodedVoiceAudio(
  audio: Float32Array,
  getRecognizer: () => Promise<any> = transcriber,
  options: VoiceTranscribeOptions = {},
): Promise<string> {
  assertVoiceAudioHasSpeech(audio);
  const recognize = await getRecognizer();
  // One language for the whole dictation, as faster-whisper does: detecting
  // per piece let one 27 s piece of Russian come out as English.
  const language =
    options.language ??
    (await (options.detectLanguage ?? detectSpokenLanguage)(recognize, audio));
  const parts: string[] = [];
  let rejected: "no-speech" | "repeated" | undefined;
  for (const [start, end] of splitVoiceAudioAtPauses(audio)) {
    const piece = audio.subarray(start, end);
    const result = await recognize(piece, {
      task: "transcribe",
      ...(language ? { language } : {}),
    });
    const rawText = Array.isArray(result) ? result[0]?.text : result?.text;
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) continue;
    const problem = voiceTranscriptProblem(text, piece.length / VOICE_SAMPLE_RATE);
    if (problem) {
      // A looped piece costs only itself, not the rest of the dictation.
      if (rejected !== "repeated") rejected = problem;
      continue;
    }
    parts.push(text);
  }
  const text = parts.join(" ").trim();
  if (text) return text;
  if (rejected === "repeated") throw new Error(REPEATED_TEXT_MESSAGE);
  if (rejected === "no-speech") throw new Error(NO_SPEECH_MESSAGE);
  throw new Error("No speech was recognized.");
}

export async function transcribeVoiceFile(
  inputPath: string,
  options: VoiceTranscribeOptions = {},
): Promise<string> {
  if (!fs.existsSync(inputPath)) {
    throw new Error("The voice recording file is no longer available.");
  }
  return transcribeDecodedVoiceAudio(
    await decodeVoiceAudio(inputPath),
    transcriber,
    options,
  );
}

function rememberTerminal(
  recordingId: string,
  state: "expired" | "error",
  message: string,
): void {
  const previous = terminalRecordings.get(recordingId);
  if (previous) clearTimeout(previous.cleanup);
  const cleanup = setTimeout(
    () => terminalRecordings.delete(recordingId),
    60_000,
  );
  cleanup.unref();
  terminalRecordings.set(recordingId, { state, message, cleanup });
}

export type VoiceStopOptions = VoiceTranscribeOptions & {
  /** Test seam; production transcribes the WAV with the packaged Whisper. */
  transcribeFile?: (
    outputPath: string,
    options: VoiceTranscribeOptions,
  ) => Promise<string>;
};

function keepRecording(
  recordingId: string,
  audio: Pick<KeptRecording, "outputPath" | "cleanupOwnedDir">,
  state: KeptRecording["state"],
  message: string,
): void {
  // One kept recording at a time: a newer one supersedes the older audio.
  for (const id of [...keptRecordings.keys()]) {
    if (id !== recordingId) discardKeptRecording(id);
  }
  const previous = keptRecordings.get(recordingId);
  if (previous) clearTimeout(previous.cleanup);
  const cleanup = setTimeout(
    () => discardKeptRecording(recordingId),
    KEPT_RECORDING_TTL_MS,
  );
  cleanup.unref();
  keptRecordings.set(recordingId, { ...audio, state, message, cleanup });
}

function discardKeptRecording(recordingId: string): void {
  const kept = keptRecordings.get(recordingId);
  if (!kept) return;
  keptRecordings.delete(recordingId);
  clearTimeout(kept.cleanup);
  kept.cleanupOwnedDir();
}

/** Silence is a property of the audio; transcribing it again cannot help. */
function worthRetrying(error: Error): boolean {
  return error.message !== NO_SPEECH_MESSAGE;
}

async function transcribeOwnedAudio(
  recordingId: string,
  audio: Pick<KeptRecording, "outputPath" | "cleanupOwnedDir">,
  options: VoiceStopOptions,
): Promise<string> {
  const { transcribeFile = transcribeVoiceFile, ...transcribeOptions } =
    options;
  try {
    const text = await transcribeFile(audio.outputPath, transcribeOptions);
    audio.cleanupOwnedDir();
    return text;
  } catch (caught) {
    const error = voiceError(caught);
    if (!worthRetrying(error)) {
      audio.cleanupOwnedDir();
      throw error;
    }
    const message = error.message.endsWith(KEPT_SUFFIX)
      ? error.message
      : `${error.message}${KEPT_SUFFIX}`;
    keepRecording(recordingId, audio, "kept", message);
    throw new Error(message);
  }
}

async function finalizeRecording(
  recordingId: string,
  mode: "stop" | "cancel" | "expire",
  options: VoiceStopOptions = {},
): Promise<string | void> {
  const existing = finalizations.get(recordingId);
  if (existing) return existing;
  const recording = recordings.get(recordingId);
  if (!recording) {
    if (mode === "stop") {
      const terminal = terminalRecordings.get(recordingId);
      throw new Error(
        terminal?.message ?? "Voice recording is no longer active.",
      );
    }
    return;
  }
  recordings.delete(recordingId);
  const operation = (async () => {
    // Who owns the WAV after the recorder stops: the transcription below or
    // the kept-audio store. Every other path removes it here.
    let handedOver = false;
    try {
      await stopRecorder(recording);
      if (mode === "cancel") return;
      const stats = fs.statSync(recording.outputPath);
      if (stats.size <= 44)
        throw new Error("No microphone audio was captured.");
      handedOver = true;
      if (mode === "expire") {
        keepRecording(recordingId, recording, "expired", EXPIRED_MESSAGE);
        return;
      }
      return await transcribeOwnedAudio(recordingId, recording, options);
    } finally {
      if (recording.durationTimer) clearTimeout(recording.durationTimer);
      if (!handedOver) recording.cleanupOwnedDir();
    }
  })();
  finalizations.set(recordingId, operation);
  try {
    return await operation;
  } finally {
    finalizations.delete(recordingId);
    if (recordingOwner === recordingId) recordingOwner = undefined;
  }
}

async function transcribeKeptRecording(
  recordingId: string,
  options: VoiceStopOptions,
): Promise<string> {
  const kept = keptRecordings.get(recordingId);
  if (!kept) throw new Error("The voice recording is no longer available.");
  keptRecordings.delete(recordingId);
  clearTimeout(kept.cleanup);
  const operation = transcribeOwnedAudio(recordingId, kept, options);
  finalizations.set(recordingId, operation);
  try {
    return await operation;
  } finally {
    finalizations.delete(recordingId);
  }
}

/**
 * Stop and transcribe. On an id whose audio is kept (five-minute limit, or a
 * failed transcription) it transcribes the kept audio: that is Retry.
 */
export async function stopVoiceRecording(
  recordingId: string,
  options: VoiceStopOptions = {},
): Promise<string> {
  const inFlight = finalizations.get(recordingId);
  if (!recordings.has(recordingId) && !inFlight) {
    if (keptRecordings.has(recordingId)) {
      return transcribeKeptRecording(recordingId, options);
    }
  }
  const transcript = await finalizeRecording(recordingId, "stop", options);
  if (typeof transcript === "string") return transcript;
  // The limit timer finalized first and kept the audio: transcribe it now.
  if (keptRecordings.has(recordingId)) {
    return transcribeKeptRecording(recordingId, options);
  }
  const terminal = terminalRecordings.get(recordingId);
  throw new Error(
    terminal?.message ??
      "Voice recording ended before it could be transcribed. Click the microphone to retry.",
  );
}

export async function cancelVoiceRecording(recordingId: string): Promise<void> {
  if (pendingRecordings.has(recordingId)) {
    cancelledStarts.add(recordingId);
  }
  await finalizeRecording(recordingId, "cancel");
  discardKeptRecording(recordingId);
}

export function voiceRecordingStatus(recordingId: string): {
  state: "starting" | "listening" | "expired" | "kept" | "error" | "unknown";
  message?: string;
} {
  if (pendingRecordings.has(recordingId) && !recordings.has(recordingId)) {
    return { state: "starting" };
  }
  const kept = keptRecordings.get(recordingId);
  if (kept && !recordings.has(recordingId)) {
    return { state: kept.state, message: kept.message };
  }
  const recording = recordings.get(recordingId);
  if (recording?.failure || recording?.exited) {
    const message =
      recording.failure?.message ||
      recording.exited?.stderr.trim() ||
      `The recording device "${recording.device}" stopped unexpectedly.`;
    rememberTerminal(recordingId, "error", message);
    void finalizeRecording(recordingId, "cancel");
    return { state: "error", message };
  }
  if (recording) return { state: "listening" };
  const terminal = terminalRecordings.get(recordingId);
  return terminal
    ? { state: terminal.state, message: terminal.message }
    : { state: "unknown" };
}
