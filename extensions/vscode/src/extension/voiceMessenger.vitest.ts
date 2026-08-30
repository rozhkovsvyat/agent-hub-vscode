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
    expect(voiceRoutes).toContain('"cukii/transcribeVoiceRecording"');
    expect(voiceRoutes).not.toContain("showErrorMessage");
    expect(voiceRoutes.match(/transcribeWebviewVoiceAudio/g)).toHaveLength(1);
  });
});
