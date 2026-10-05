import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * The optional, larger speech model (card 364dbc2f: "why not the same model
 * the agent uses for iPhone voice notes?" — that is Whisper small). Measured
 * 2026-10-05 on the owner's real 188 s Russian dictation through the same
 * pause-split pipeline: whisper-base 5/16 key phrases of the faster-whisper
 * reference, whisper-small 12/16, at about twice the time (35 s). It does not
 * fit the VSIX — 249 MB on top of each of five platform carriers — so it is
 * an opt-in, one-time download, pinned to one Hugging Face revision and
 * verified file by file like the packaged base model.
 */
export const WHISPER_SMALL_REVISION =
  "2d67713f236afa48a18992566e7647f6ca848e13";
export const WHISPER_SMALL_FILES: Readonly<Record<string, string>> = {
  "config.json":
    "5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be",
  "generation_config.json":
    "0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279",
  "preprocessor_config.json":
    "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d",
  "tokenizer_config.json":
    "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce",
  "tokenizer.json":
    "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566",
  "onnx/encoder_model_quantized.onnx":
    "969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06",
  "onnx/decoder_model_merged_quantized.onnx":
    "fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24",
};
/** Shown to the user before the download starts. */
export const WHISPER_SMALL_DOWNLOAD_MB = 250;

/** What transformers.js needs to load a model from disk. */
export type VoiceModelChoice = {
  /** `env.localModelPath`: the directory that holds `<id>`. */
  localModelPath: string;
  /** Model id relative to `localModelPath`. */
  id: string;
  /** Where the files live, for integrity verification. */
  dir: string;
  files: Readonly<Record<string, string>>;
};

export function whisperSmallChoice(storageDir: string): VoiceModelChoice {
  const localModelPath = path.join(storageDir, "models");
  const id = `whisper-small/${WHISPER_SMALL_REVISION}`;
  return {
    localModelPath,
    id,
    dir: path.join(localModelPath, ...id.split("/")),
    files: WHISPER_SMALL_FILES,
  };
}

export function verifyModelFiles(
  dir: string,
  files: Readonly<Record<string, string>>,
): { valid: boolean; reason?: string } {
  for (const [relativePath, expected] of Object.entries(files)) {
    const filePath = path.join(dir, ...relativePath.split("/"));
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: `missing ${relativePath}` };
    }
    const digest = createHash("sha256")
      .update(fs.readFileSync(filePath))
      .digest("hex");
    if (digest !== expected) {
      return { valid: false, reason: `checksum mismatch for ${relativePath}` };
    }
  }
  return { valid: true };
}

/**
 * The model the next dictation should use: whisper-small only when the user
 * chose it AND every pinned file is on disk and intact; otherwise undefined,
 * which means the packaged whisper-base.
 */
export function resolveVoiceModelChoice(
  setting: string | undefined | null,
  storageDir: string,
  verify: typeof verifyModelFiles = verifyModelFiles,
): VoiceModelChoice | undefined {
  if ((setting ?? "").trim().toLowerCase() !== "small") return undefined;
  const choice = whisperSmallChoice(storageDir);
  return verify(choice.dir, choice.files).valid ? choice : undefined;
}

type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}>;

/**
 * Downloads every missing or damaged file of the pinned revision. Each file
 * streams into `<name>.part` and is renamed only after its SHA-256 matches,
 * so an interrupted or tampered download can never be loaded.
 */
export async function downloadWhisperSmall(
  storageDir: string,
  options: {
    fetchImpl?: FetchLike;
    signal?: AbortSignal;
    onProgress?: (done: number, file: string) => void;
    baseUrl?: string;
  } = {},
): Promise<VoiceModelChoice> {
  const choice = whisperSmallChoice(storageDir);
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const baseUrl =
    options.baseUrl ??
    `https://huggingface.co/Xenova/whisper-small/resolve/${WHISPER_SMALL_REVISION}`;
  let done = 0;
  for (const [relativePath, expected] of Object.entries(choice.files)) {
    const target = path.join(choice.dir, ...relativePath.split("/"));
    if (verifyModelFiles(path.dirname(target), {
      [path.basename(target)]: expected,
    }).valid) {
      options.onProgress?.(++done, relativePath);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const partial = `${target}.part`;
    const response = await fetchImpl(`${baseUrl}/${relativePath}`, {
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Downloading ${relativePath} failed with HTTP ${response.status}.`,
      );
    }
    const hash = createHash("sha256");
    const out = fs.createWriteStream(partial);
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        hash.update(value);
        if (!out.write(value)) {
          await new Promise<void>((resolve) => out.once("drain", resolve));
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      out.destroy();
      fs.rmSync(partial, { force: true });
      throw error;
    }
    const digest = hash.digest("hex");
    if (digest !== expected) {
      fs.rmSync(partial, { force: true });
      throw new Error(
        `Downloaded ${relativePath} does not match its pinned checksum; nothing was installed.`,
      );
    }
    fs.renameSync(partial, target);
    options.onProgress?.(++done, relativePath);
  }
  return choice;
}
