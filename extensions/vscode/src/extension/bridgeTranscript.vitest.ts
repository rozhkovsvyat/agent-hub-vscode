import { describe, expect, it } from "vitest";

import {
  buildBridgeTranscript,
  MAX_BRIDGE_TRANSCRIPT_CHARS,
} from "./bridgeTranscript";

describe("buildBridgeTranscript", () => {
  it("keeps a short history byte-for-byte", () => {
    expect(
      buildBridgeTranscript([
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ]),
    ).toBe("USER:\nfirst\n\nASSISTANT:\nsecond");
  });

  it("bounds an oversized history and retains the latest request", () => {
    const latest = "LATEST REQUEST MUST SURVIVE";
    const transcript = buildBridgeTranscript([
      { role: "user", content: "x".repeat(MAX_BRIDGE_TRANSCRIPT_CHARS) },
      { role: "assistant", content: "y".repeat(MAX_BRIDGE_TRANSCRIPT_CHARS) },
      { role: "user", content: latest },
    ]);

    expect(transcript.length).toBeLessThanOrEqual(MAX_BRIDGE_TRANSCRIPT_CHARS);
    expect(transcript).toContain("Cukii transcript omitted");
    expect(transcript).toContain(latest);
  });

  it("bounds one oversized latest turn while retaining its leading instruction", () => {
    const instruction = "DO NOT DELETE FILES";
    const transcript = buildBridgeTranscript([
      {
        role: "user",
        content:
          instruction + "\n" + "z".repeat(MAX_BRIDGE_TRANSCRIPT_CHARS + 1),
      },
    ]);

    expect(transcript.length).toBe(MAX_BRIDGE_TRANSCRIPT_CHARS);
    expect(transcript).toContain(instruction);
    expect(transcript).toContain("Current turn middle omitted");
  });
});
