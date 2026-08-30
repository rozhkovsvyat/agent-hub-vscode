import { execFile, spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import type * as vscode from "vscode";

const execFileAsync = promisify(execFile);

const WHISPER_MODEL = "Xenova/whisper-base";
const WHISPER_REVISION = "64da57285918e20ea79ea5c88eed7197933abaa8";
export const MAX_VOICE_RECORDING_MS = 5 * 60 * 1000;
const WHISPER_CACHE_DIR = path.join(
  os.homedir(),
  ".agent-hub",
  "models",
  "whisper",
);
const WHISPER_FILES: Record<string, string> = {
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
  outputPath: string;
  device: string;
  exited?: { code: number | null; stderr: string };
  failure?: Error;
  durationTimer?: NodeJS.Timeout;
};

const recordings = new Map<string, Recording>();
const pendingRecordings = new Set<string>();
const cancelledStarts = new Set<string>();
const finalizations = new Map<string, Promise<string | void>>();
const terminalRecordings = new Map<
  string,
  { state: "expired" | "error"; message: string; cleanup: NodeJS.Timeout }
>();
let transcriberPromise: Promise<any> | undefined;

type VoiceRecordingOptions = {
  resolveDevice?: () => Promise<string>;
  spawnRecorder?: typeof spawn;
  startupDelayMs?: number;
  maxDurationMs?: number;
  tempDir?: string;
};

function whisperModelDir(cacheDir = WHISPER_CACHE_DIR): string {
  return path.join(cacheDir, "Xenova", "whisper-base", WHISPER_REVISION);
}

export function verifyWhisperCache(cacheDir = WHISPER_CACHE_DIR): {
  valid: boolean;
  reason?: string;
} {
  const modelDir = whisperModelDir(cacheDir);
  for (const [relativePath, expectedHash] of Object.entries(WHISPER_FILES)) {
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

function discardPartialWhisperCache(): void {
  fs.rmSync(whisperModelDir(), { recursive: true, force: true });
}

export function parseDirectShowAudioDevices(stderr: string): string[] {
  return [...stderr.matchAll(/"([^"]+)"\s+\(audio\)/g)].map(
    (match) => match[1],
  );
}

async function audioDevice(): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error(
      "Voice input is currently available on Windows only. Cukii needs a platform recorder for this operating system.",
    );
  }
  const ffmpeg = voiceFfmpegExecutable();
  let stderr = "";
  try {
    const result = await execFileAsync(
      ffmpeg,
      ["-hide_banner", "-f", "dshow", "-list_devices", "true", "-i", "dummy"],
      { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    stderr = String(result.stderr ?? "");
  } catch (error) {
    stderr = String((error as { stderr?: unknown }).stderr ?? "");
  }
  const devices = parseDirectShowAudioDevices(stderr);
  const preferred = devices.find(
    (device) => !/streaming|virtual/i.test(device),
  );
  if (!preferred && devices.length === 0) {
    throw new Error("No Windows recording device was found.");
  }
  return preferred ?? devices[0];
}

async function waitForRecorderStart(
  recording: Recording,
  startupDelayMs: number,
  isCancelled: () => boolean,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
  if (isCancelled()) throw new Error("Voice recording was cancelled.");
  if (recording.exited) {
    throw new Error(
      recording.exited.stderr.trim() ||
        "The recording device could not be opened.",
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
  pendingRecordings.add(recordingId);
  let outputPath: string | undefined;
  try {
    const device = await (options.resolveDevice ?? audioDevice)();
    if (cancelledStarts.delete(recordingId)) {
      throw new Error("Voice recording was cancelled.");
    }
    outputPath = path.join(
      options.tempDir ?? os.tmpdir(),
      `cukii-voice-${recordingId}.wav`,
    );
    const child = (options.spawnRecorder ?? spawn)(
      voiceFfmpegExecutable(),
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "dshow",
        "-audio_buffer_size",
        "50",
        "-i",
        `audio=${device}`,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-y",
        outputPath,
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
    );
    const recording: Recording = { process: child, outputPath, device };
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
    return { recordingId, device };
  } catch (error) {
    if (recordings.has(recordingId)) {
      await finalizeRecording(recordingId, "cancel");
    } else if (outputPath) {
      fs.rmSync(outputPath, { force: true });
    }
    throw error;
  } finally {
    pendingRecordings.delete(recordingId);
    cancelledStarts.delete(recordingId);
  }
}

async function stopRecorder(recording: Recording): Promise<void> {
  if (recording.durationTimer) clearTimeout(recording.durationTimer);
  if (recording.exited) return;
  await requestRecorderQuit(recording.process.stdin);
  if (await waitForProcessExit(recording, 5_000)) return;
  recording.process.kill();
  if (!(await waitForProcessExit(recording, 2_000))) {
    throw new Error("The audio recorder did not stop after termination.");
  }
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
  const initialCacheState = verifyWhisperCache();
  if (!initialCacheState.valid && fs.existsSync(whisperModelDir())) {
    discardPartialWhisperCache();
  }
  const load = async (progress?: vscode.Progress<{ message?: string }>) => {
    const { env, pipeline } = await import("@xenova/transformers");
    env.cacheDir = WHISPER_CACHE_DIR;
    env.useFSCache = true;
    env.useBrowserCache = false;
    return pipeline("automatic-speech-recognition", WHISPER_MODEL, {
      revision: WHISPER_REVISION,
      progress_callback: (update: {
        status?: string;
        file?: string;
        progress?: number;
      }) => {
        const suffix =
          update.progress === undefined
            ? ""
            : ` ${Math.round(update.progress)}%`;
        progress?.report({
          message: update.file
            ? `${update.status ?? "Downloading"}: ${update.file}${suffix}`
            : "Preparing local speech recognition…",
        });
      },
    });
  };

  let loaded: any;
  try {
    if (initialCacheState.valid) {
      loaded = await load();
    } else {
      let api: typeof vscode | undefined;
      try {
        api = createRequire(__filename)("vscode") as typeof vscode;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
          throw error;
        }
      }
      loaded = api
        ? await api.window.withProgress(
            {
              location: api.ProgressLocation.Notification,
              title: "Cukii: downloading local Whisper model (one time)",
              cancellable: false,
            },
            (progress) => load(progress),
          )
        : await load();
    }
  } catch (error) {
    if (!initialCacheState.valid) discardPartialWhisperCache();
    throw error;
  }

  const finalCacheState = verifyWhisperCache();
  if (!finalCacheState.valid) {
    discardPartialWhisperCache();
    throw new Error(
      `The downloaded Whisper model failed integrity verification: ${finalCacheState.reason}. Retry voice input to download a clean copy.`,
    );
  }
  return loaded;
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

export function assertVoiceTranscriptIsUsable(
  text: string,
  durationSeconds: number,
): void {
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
    throw new Error(
      "Speech recognition returned repeated text. Check the selected microphone and try again.",
    );
  }
}

export async function transcribeDecodedVoiceAudio(
  audio: Float32Array,
  getRecognizer: () => Promise<any> = transcriber,
): Promise<string> {
  assertVoiceAudioHasSpeech(audio);
  const recognize = await getRecognizer();
  const result = await recognize(audio, {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
  });
  const rawText = Array.isArray(result) ? result[0]?.text : result?.text;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) throw new Error("No speech was recognized.");
  assertVoiceTranscriptIsUsable(text, audio.length / 16_000);
  return text;
}

export async function transcribeVoiceFile(inputPath: string): Promise<string> {
  if (!fs.existsSync(inputPath)) {
    throw new Error("The voice recording file is no longer available.");
  }
  return transcribeDecodedVoiceAudio(await decodeVoiceAudio(inputPath));
}

export type WebviewVoiceAudio = {
  recordingId: string;
  /** Base64 audio bytes (not a data URL) emitted by MediaRecorder. */
  audioBase64: string;
  mimeType: string;
  sampleRate?: number;
  durationMs?: number;
};

const MAX_WEBVIEW_VOICE_BYTES = 25 * 1024 * 1024;

function extensionForVoiceMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";", 1)[0].trim();
  if (normalized === "audio/webm") return ".webm";
  if (normalized === "audio/ogg") return ".ogg";
  if (normalized === "audio/wav" || normalized === "audio/wave") return ".wav";
  if (normalized === "audio/mp4" || normalized === "audio/m4a") return ".m4a";
  throw new Error(
    "This microphone recording format is not supported. Retry with the default microphone.",
  );
}

function decodeWebviewVoiceAudio(audioBase64: string): Buffer {
  // Buffer.from accepts malformed base64 silently. Rejecting it before writing
  // a file keeps a stale/webview-corrupted recording distinct from a genuine
  // no-speech transcription result.
  if (!audioBase64) {
    throw new Error("No microphone audio was captured.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(audioBase64)) {
    throw new Error("The microphone recording data was invalid. Please retry.");
  }
  const bytes = Buffer.from(audioBase64, "base64");
  if (bytes.byteLength === 0) {
    throw new Error("No microphone audio was captured.");
  }
  if (bytes.byteLength > MAX_WEBVIEW_VOICE_BYTES) {
    throw new Error(
      "The microphone recording is too large. Record a shorter message and retry.",
    );
  }
  return bytes;
}

/**
 * The browser/webview is the sole microphone owner. It supplies the exact
 * MediaRecorder bytes and metadata; the extension host writes a short-lived
 * private file only because the existing sanctioned ffmpeg/Whisper pipeline
 * decodes files. Nothing is logged and the file is removed in every outcome.
 */
export async function transcribeWebviewVoiceAudio(
  payload: WebviewVoiceAudio,
  transcribe: (inputPath: string) => Promise<string> = transcribeVoiceFile,
  tempDir = os.tmpdir(),
): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(payload.recordingId)) {
    throw new Error("Invalid voice recording identifier.");
  }
  if (
    payload.sampleRate !== undefined &&
    (!Number.isFinite(payload.sampleRate) || payload.sampleRate <= 0)
  ) {
    throw new Error(
      "The microphone reported an invalid sample rate. Please retry.",
    );
  }
  if (
    payload.durationMs !== undefined &&
    (!Number.isFinite(payload.durationMs) || payload.durationMs <= 0)
  ) {
    throw new Error("The microphone recording was empty. Please try again.");
  }

  const extension = extensionForVoiceMimeType(payload.mimeType);
  const bytes = decodeWebviewVoiceAudio(payload.audioBase64);
  const inputPath = path.join(
    tempDir,
    `cukii-voice-${payload.recordingId}${extension}`,
  );
  try {
    fs.writeFileSync(inputPath, bytes, { flag: "wx" });
    return await transcribe(inputPath);
  } finally {
    fs.rmSync(inputPath, { force: true });
  }
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

async function finalizeRecording(
  recordingId: string,
  mode: "stop" | "cancel" | "expire",
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
    try {
      await stopRecorder(recording);
      if (mode === "expire") {
        rememberTerminal(
          recordingId,
          "expired",
          "Voice recording reached the five-minute limit. Click the microphone to retry.",
        );
        return;
      }
      if (mode === "cancel") return;
      const stats = fs.statSync(recording.outputPath);
      if (stats.size <= 44)
        throw new Error("No microphone audio was captured.");
      return await transcribeVoiceFile(recording.outputPath);
    } finally {
      if (recording.durationTimer) clearTimeout(recording.durationTimer);
      fs.rmSync(recording.outputPath, { force: true });
    }
  })();
  finalizations.set(recordingId, operation);
  try {
    return await operation;
  } finally {
    finalizations.delete(recordingId);
  }
}

export async function stopVoiceRecording(recordingId: string): Promise<string> {
  const transcript = await finalizeRecording(recordingId, "stop");
  if (typeof transcript !== "string") {
    const terminal = terminalRecordings.get(recordingId);
    throw new Error(
      terminal?.message ??
        "Voice recording ended before it could be transcribed. Click the microphone to retry.",
    );
  }
  return transcript;
}

export async function cancelVoiceRecording(recordingId: string): Promise<void> {
  if (pendingRecordings.has(recordingId)) {
    cancelledStarts.add(recordingId);
  }
  await finalizeRecording(recordingId, "cancel");
}

export function voiceRecordingStatus(recordingId: string): {
  state: "starting" | "listening" | "expired" | "error" | "unknown";
  message?: string;
} {
  if (pendingRecordings.has(recordingId) && !recordings.has(recordingId)) {
    return { state: "starting" };
  }
  if (recordings.has(recordingId)) return { state: "listening" };
  const terminal = terminalRecordings.get(recordingId);
  return terminal
    ? { state: terminal.state, message: terminal.message }
    : { state: "unknown" };
}
