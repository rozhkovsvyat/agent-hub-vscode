import { describe, expect, it } from "vitest";

import {
  bridgeTranscriptCharLimit,
  buildBridgeTranscript,
  MAX_BRIDGE_TRANSCRIPT_CHARS,
} from "./bridgeTranscript";

describe("buildBridgeTranscript", () => {
  it("scales the transcript budget with the selected native model", () => {
    expect(bridgeTranscriptCharLimit("grok-4-6")).toBe(300_000);
    expect(bridgeTranscriptCharLimit("cursor:grok-4.6")).toBe(300_000);
    expect(bridgeTranscriptCharLimit("opus-5")).toBe(600_000);
    expect(bridgeTranscriptCharLimit("codex-5-6-sol")).toBe(153_000);
    expect(bridgeTranscriptCharLimit("unknown-future-model")).toBe(
      MAX_BRIDGE_TRANSCRIPT_CHARS,
    );
  });

  it("keeps Grok history that exceeded the old universal 120K ceiling", () => {
    const body = "x".repeat(MAX_BRIDGE_TRANSCRIPT_CHARS + 10_000);
    const transcript = buildBridgeTranscript(
      [{ role: "user", content: body }],
      bridgeTranscriptCharLimit("grok-4-6"),
    );

    expect(transcript).toBe(`USER:\n${body}`);
    expect(transcript).not.toContain("outside this window");
  });
  it("keeps a short history byte-for-byte", () => {
    expect(
      buildBridgeTranscript([
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ]),
    ).toBe("USER:\nfirst\n\nASSISTANT:\nsecond");
  });

  it("drops turns that carry no text instead of emitting bare role lines", () => {
    const transcript = buildBridgeTranscript([
      { role: "user", content: "first" },
      // Assistant turns holding only tool calls arrive empty; a long session
      // produced dozens of bare `ASSISTANT:` lines in a row (card 53b13ded).
      { role: "assistant", content: "" },
      { role: "assistant", content: "   \n  " },
      { role: "assistant", content: [] },
      { role: "assistant", content: "second" },
    ]);

    expect(transcript).toBe("USER:\nfirst\n\nASSISTANT:\nsecond");
    expect(transcript).not.toMatch(/ASSISTANT:\n\nASSISTANT:/);
  });

  it("bounds an oversized history and retains the latest request", () => {
    const latest = "LATEST REQUEST MUST SURVIVE";
    const transcript = buildBridgeTranscript([
      { role: "user", content: "x".repeat(MAX_BRIDGE_TRANSCRIPT_CHARS) },
      { role: "assistant", content: "y".repeat(MAX_BRIDGE_TRANSCRIPT_CHARS) },
      { role: "user", content: latest },
    ]);

    expect(transcript.length).toBeLessThanOrEqual(MAX_BRIDGE_TRANSCRIPT_CHARS);
    expect(transcript).toContain("Earlier turns are outside this window");
    expect(transcript).toContain("retained latest context");
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
    expect(transcript).toContain("[...]");
  });
});
