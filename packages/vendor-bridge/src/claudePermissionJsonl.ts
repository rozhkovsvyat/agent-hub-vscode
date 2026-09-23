export type JsonlFrame = { type: "line"; line: string } | { type: "oversize" };

/**
 * Incremental newline-delimited JSON framing with a hard per-frame limit.
 * A corrupt frame never poisons later valid frames batched in the same chunk.
 */
export class JsonlFrameReader {
  private buffer = "";
  private discardingOversizedFrame = false;

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer | string): JsonlFrame[] {
    let incoming = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const frames: JsonlFrame[] = [];

    if (this.discardingOversizedFrame) {
      const boundary = incoming.indexOf("\n");
      if (boundary < 0) return frames;
      this.discardingOversizedFrame = false;
      incoming = incoming.slice(boundary + 1);
    }

    this.buffer += incoming;
    let boundary = this.buffer.indexOf("\n");
    while (boundary >= 0) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      frames.push(
        Buffer.byteLength(line, "utf8") > this.maxFrameBytes
          ? { type: "oversize" }
          : { type: "line", line },
      );
      boundary = this.buffer.indexOf("\n");
    }

    // A peer may never terminate a malicious frame. Bound memory, then skip
    // only that frame through its next newline.
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxFrameBytes) {
      this.buffer = "";
      this.discardingOversizedFrame = true;
      frames.push({ type: "oversize" });
    }
    return frames;
  }
}
