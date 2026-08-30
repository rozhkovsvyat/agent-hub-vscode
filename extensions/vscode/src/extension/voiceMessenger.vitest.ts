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
    expect(runtime).toContain('env.localModelPath = path.join(__dirname, "models")');
    expect(runtime).not.toContain("Downloading local Whisper model");
  });
});
