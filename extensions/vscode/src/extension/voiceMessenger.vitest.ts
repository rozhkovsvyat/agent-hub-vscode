import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

describe("voice messenger error channel", () => {
  it("returns route errors to the owning webview and never emits a second host toast", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "VsCodeMessenger.ts"),
      "utf8",
    );
    const voiceRoutes = source.slice(
      source.indexOf('this.onWebview("cukii/startVoiceRecording"'),
      source.indexOf('this.onWebview("cukii/runVendorAuthAction"'),
    );
    expect(voiceRoutes).toContain('"cukii/stopVoiceRecording"');
    expect(voiceRoutes).toContain('"cukii/cancelVoiceRecording"');
    expect(voiceRoutes).toContain('"cukii/voiceRecordingStatus"');
    expect(voiceRoutes).toContain("resolveWhisperTranscribeLanguage");
    expect(voiceRoutes).toContain("voiceLanguage");
    // The display language forced Whisper to translate (card 364dbc2f).
    expect(voiceRoutes).not.toContain("vscode.env.language");
    expect(voiceRoutes).not.toContain('"cukii/transcribeVoiceRecording"');
    expect(voiceRoutes).not.toContain("showErrorMessage");
    expect(voiceRoutes).not.toContain("audioBase64");
  });

  it("keeps the production webview and protocol free of browser audio transport", () => {
    const root = path.resolve(__dirname, "../../../..");
    const gui = fs.readFileSync(
      path.join(root, "gui/src/components/mainInput/VoiceInputButton.tsx"),
      "utf8",
    );
    const protocol = fs.readFileSync(
      path.join(root, "core/protocol/ideWebview.ts"),
      "utf8",
    );
    expect(gui).not.toMatch(/getUserMedia|MediaRecorder|audioBase64/);
    expect(protocol).not.toMatch(/transcribeVoiceRecording|audioBase64/);
    expect(gui).toContain('"cukii/startVoiceRecording"');
    expect(gui).toContain('"cukii/stopVoiceRecording"');
  });

  it("copies one pinned offline Whisper model into the packaged output", () => {
    const extensionRoot = path.resolve(__dirname, "../..");
    const build = fs.readFileSync(
      path.join(extensionRoot, "scripts/esbuild.js"),
      "utf8",
    );
    const ignore = fs.readFileSync(
      path.join(extensionRoot, ".vscodeignore"),
      "utf8",
    );
    const probe = fs.readFileSync(
      path.join(extensionRoot, "scripts/probe-voice-package.js"),
      "utf8",
    );
    const runtime = fs.readFileSync(
      path.join(extensionRoot, "src/extension/voiceDictation.ts"),
      "utf8",
    );
    expect(build).toContain("fs.cpSync(whisperSource, whisperOutput");
    expect(ignore).toContain("models/whisper-base/**");
    expect(ignore).not.toContain("out/models");
    expect(probe).toContain("verifyPackagedWhisperModel");
    expect(probe).toContain("Network access is disabled");
    expect(runtime).toContain("env.allowRemoteModels = false");
    expect(runtime).toContain(
      'env.localModelPath = model?.localModelPath ?? path.join(__dirname, "models")',
    );
    expect(runtime).not.toContain("Downloading local Whisper model");
  });

  it("offers the better speech model as a registered, checksum-verified opt-in", () => {
    const root = path.resolve(__dirname, "../../../..");
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(root, "extensions/vscode/package.json"),
        "utf8",
      ),
    );
    const setting =
      manifest.contributes.configuration.properties["cukii.voiceModel"];
    expect(setting.enum).toEqual(["base", "small"]);
    expect(setting.default).toBe("base");
    // The download size is promised in the setting text and in the toast.
    expect(setting.markdownDescription).toContain("250 MB");
    const messenger = fs.readFileSync(
      path.join(root, "extensions/vscode/src/extension/VsCodeMessenger.ts"),
      "utf8",
    );
    // Dictation picks the model up only once it is fully on disk…
    expect(messenger).toContain(
      'event.affectsConfiguration("cukii.voiceModel")',
    );
    expect(messenger).toContain("model: this.voiceModelChoice()");
    expect(messenger).toContain("WHISPER_SMALL_DOWNLOAD_MB} MB");
    // …and the transcribe path honors it instead of the packaged base.
    const runtime = fs.readFileSync(
      path.join(root, "extensions/vscode/src/extension/voiceDictation.ts"),
      "utf8",
    );
    expect(runtime).toContain("transcriber(options.model)");
    expect(runtime).toContain("model?.localModelPath ??");
    expect(runtime).toContain("model?.id ?? `whisper-base/");
  });
});
