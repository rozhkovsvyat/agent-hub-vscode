const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

async function probeExtracted(extensionRoot, wavPath) {
  const ffmpegPath = path.join(
    extensionRoot,
    "out",
    "runtime",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  const ffmpeg = fs.readFileSync(ffmpegPath);
  const ffmpegHash = crypto.createHash("sha256").update(ffmpeg).digest("hex");
  const version = spawnSync(ffmpegPath, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (version.status !== 0) throw new Error(version.stderr || "ffmpeg failed");

  const onnx = require(path.join(
    extensionRoot,
    "out",
    "node_modules",
    "onnxruntime-node",
  ));
  if (typeof onnx.InferenceSession !== "function") {
    throw new Error("Packaged onnxruntime-node did not load its native binding");
  }

  global.fetch = async () => {
    throw new Error("Network access is disabled by the packaged offline probe");
  };
  const voice = require(path.join(extensionRoot, "out", "voiceDictation.js"));
  const transcript = await voice.transcribeVoiceFile(wavPath);
  console.log(
    JSON.stringify(
      {
        ffmpeg: {
          path: "extension/out/runtime/ffmpeg.exe",
          size: ffmpeg.byteLength,
          sha256: ffmpegHash,
          version: version.stdout.split(/\r?\n/, 1)[0],
        },
        onnxNativeBinding: true,
        whisperCache: voice.verifyWhisperCache(),
        offline: true,
        transcript,
      },
      null,
      2,
    ),
  );
}

async function main() {
  const [vsixArg, wavArg, insideWavArg] = process.argv.slice(2);
  if (vsixArg === "--inside") {
    await probeExtracted(path.resolve(wavArg), path.resolve(insideWavArg));
    return;
  }
  if (!vsixArg || !wavArg) {
    throw new Error("Usage: node scripts/probe-voice-package.js <vsix> <wav>");
  }
  const vsixPath = path.resolve(vsixArg);
  const wavPath = path.resolve(wavArg);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-voice-vsix-"));
  try {
    const extract = spawnSync("tar", ["-xf", vsixPath, "-C", destination], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (extract.status !== 0) {
      throw new Error(extract.stderr || "Could not extract the VSIX");
    }
    const extensionRoot = path.join(destination, "extension");
    const child = spawnSync(
      process.execPath,
      [__filename, "--inside", extensionRoot, wavPath],
      { encoding: "utf8", windowsHide: true },
    );
    process.stdout.write(child.stdout ?? "");
    process.stderr.write(child.stderr ?? "");
    if (child.status !== 0) {
      throw new Error(`Packaged voice probe failed with exit ${child.status}`);
    }
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
