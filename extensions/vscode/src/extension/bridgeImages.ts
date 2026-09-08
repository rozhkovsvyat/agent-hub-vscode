import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ChatMessage, MessageContent, MessagePart } from "core";
import { brokerImageCarrierForModel } from "core/cukiiPermissionModes";
import type { BrokerModel } from "core/protocol/ideWebview";
import { getContinueGlobalPath } from "core/util/paths";

/**
 * Text-only native bridges cannot carry bitmap blocks, so the transcript used
 * to say "[image attached]" and the worker stayed blind. Materialize data-URL
 * attachments on disk instead: the newest user turn becomes an @-mention (CLIs
 * that expand file mentions inline the picture), while older turns keep plain
 * path references so replayed history does not bloat every model request.
 */

const DATA_IMAGE_URL = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

const SUPPORTED_NATIVE_VISION_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export type ParsedVisionDataUrl = {
  mimeType: string;
  data: string;
};

/**
 * Parse the formats accepted by the native Claude/Grok vision transports.
 * This is deliberately enforced again in the extension: restored session
 * data did not necessarily pass through the current GUI's ingress checks.
 */
export function parseSupportedVisionDataUrl(
  url: string | undefined,
): ParsedVisionDataUrl | undefined {
  const matched = url?.match(DATA_IMAGE_URL);
  if (!matched) return undefined;
  const mimeType =
    matched[1].toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : matched[1].toLowerCase();
  if (!SUPPORTED_NATIVE_VISION_MIME_TYPES.has(mimeType)) return undefined;
  return { mimeType, data: matched[2].replace(/\s/g, "") };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

const RETAINED_SCOPE_MS = 7 * 24 * 60 * 60 * 1000;
const RUN_SCOPE_NAME = /^run-(\d+)-[a-f0-9-]{36}$/i;
const RELEASED_MARKER = ".released";

export function bridgeAttachmentDir(): string {
  return path.join(getContinueGlobalPath(), "bridge-attachments");
}

function isDirectChild(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relative.includes(path.sep)
  );
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeOwnedScope(scopeDir: string, root: string): void {
  const resolved = path.resolve(scopeDir);
  if (!isDirectChild(resolved, root)) return;
  try {
    const stats = fs.lstatSync(resolved);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return;
    fs.rmSync(resolved, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // Cleanup is best-effort. Leaving an owned directory behind is safer
      // than letting housekeeping change delivery semantics.
    }
  }
}

/**
 * Retire only run scopes that can no longer belong to a live bridge. A scope
 * owned by another extension host is never inspected or pruned while that
 * process is alive. Released/inbox scopes and crash remnants stay for the
 * same seven-day window as their broker-inbox records.
 */
function pruneExpiredScopes(root: string): void {
  const cutoff = Date.now() - RETAINED_SCOPE_MS;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(RUN_SCOPE_NAME);
    if (!match) continue;
    const scopeDir = path.join(root, entry.name);
    const releasedMarker = path.join(scopeDir, RELEASED_MARKER);
    let lastUseMs = 0;
    let released = false;
    try {
      const markerStats = fs.statSync(releasedMarker);
      released = markerStats.isFile();
      lastUseMs = markerStats.mtimeMs;
    } catch {
      try {
        lastUseMs = fs.statSync(scopeDir).mtimeMs;
      } catch {
        continue;
      }
    }
    const ownerAlive = processIsAlive(Number(match[1]));
    if (lastUseMs < cutoff && (released || !ownerAlive)) {
      removeOwnedScope(scopeDir, root);
    }
  }
}

/**
 * Owns every materialized image referenced by one bridge consumer lifetime.
 * Run history gets one scope; each durable inbox record gets an isolated peer
 * so retaining that record can never pin unrelated history files.
 */
export class BridgeImageScope {
  private scopeDir: string | undefined;
  private canonicalRoot: string | undefined;
  private disposed = false;
  private retainAfterDispose = false;

  constructor(private readonly requestedRoot: string = bridgeAttachmentDir()) {}

  get directory(): string {
    if (this.disposed) {
      throw new Error("Bridge image scope is already disposed");
    }
    if (this.scopeDir) return this.scopeDir;
    fs.mkdirSync(this.requestedRoot, { recursive: true });
    const root = fs.realpathSync.native(this.requestedRoot);
    this.canonicalRoot = root;
    pruneExpiredScopes(root);
    const scopeDir = path.join(root, `run-${process.pid}-${randomUUID()}`);
    fs.mkdirSync(scopeDir);
    this.scopeDir = scopeDir;
    return scopeDir;
  }

  materializeMessages(messages: ChatMessage[]): ChatMessage[] {
    return materializeBridgeImages(messages, this.directory);
  }

  /**
   * Persist one live inbox message with a peer scope that contains only the
   * files referenced by that record. Cold-start/history images stay owned by
   * this run and are removed at its teardown. A failed inbox write removes the
   * peer immediately because no durable record can reference its paths.
   */
  persistInboxMessage(
    content: MessageContent,
    persist: (materializedContent: string) => boolean,
  ): boolean {
    const needsFiles =
      Array.isArray(content) &&
      content.some(
        (part) =>
          part.type === "imageUrl" &&
          DATA_IMAGE_URL.test(part.imageUrl?.url ?? ""),
      );
    if (!needsFiles) {
      return persist(
        materializeBridgeMessageContent(content, this.requestedRoot),
      );
    }

    const inboxScope = new BridgeImageScope(this.requestedRoot);
    try {
      const rendered = materializeBridgeMessageContent(
        content,
        inboxScope.directory,
      );
      const written = persist(rendered);
      if (written) inboxScope.retainAfterDispose = true;
      return written;
    } finally {
      inboxScope.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const scopeDir = this.scopeDir;
    const root = this.canonicalRoot;
    if (!scopeDir || !root) return;
    if (this.retainAfterDispose) {
      try {
        fs.writeFileSync(
          path.join(scopeDir, RELEASED_MARKER),
          new Date().toISOString(),
          { encoding: "utf8", flag: "wx" },
        );
      } catch {
        // A leak is safer than invalidating a path still present in inbox.
      }
      return;
    }
    removeOwnedScope(scopeDir, root);
  }
}

type Materialized =
  | { kind: "file"; filePath: string }
  | { kind: "unsupported" };

function materializeDataUrl(url: string, dir: string): Materialized {
  const matched = url.match(DATA_IMAGE_URL);
  if (!matched) {
    return { kind: "unsupported" };
  }
  const mime = matched[1].toLowerCase();
  const bytes = Buffer.from(matched[2].replace(/\s/g, ""), "base64");
  const extension = EXTENSION_BY_MIME[mime] ?? ".img";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const filePath = path.join(dir, `${digest}${extension}`);
  const temporaryPath = path.join(
    dir,
    `.${digest}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    const complete = () => {
      try {
        const stat = fs.statSync(filePath);
        return (
          stat.isFile() &&
          stat.size === bytes.byteLength &&
          fs.readFileSync(filePath).equals(bytes)
        );
      } catch {
        return false;
      }
    };
    if (!complete()) {
      fs.writeFileSync(temporaryPath, bytes, { flag: "wx" });
      if (!complete()) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.renameSync(temporaryPath, filePath);
      }
    }
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Cukii could not materialize an image attachment in ${dir}: ${detail}. ` +
        "The vendor was not started because silently dropping the image would change the request.",
    );
  } finally {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup only; the final content-addressed file is intact.
    }
  }
  return { kind: "file", filePath };
}

function renderImageReference(
  url: string | undefined,
  inline: boolean,
  dir: string,
): string {
  if (!url) {
    return "[image attached]";
  }
  if (/^https?:\/\//i.test(url)) {
    return `[image: ${url}]`;
  }
  const materialized = materializeDataUrl(url, dir);
  if (materialized.kind === "file") {
    return inline
      ? `@${materialized.filePath}`
      : `[image saved at ${materialized.filePath}]`;
  }
  return "[image attached]";
}

export function hasImageAttachment(messages: ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "imageUrl"),
  );
}

/**
 * Bind image bytes to the route that will actually carry them. Session
 * history keeps the exact original in `url` so switching vendors cannot
 * destroy detail retroactively; only Grok's one-shot `--prompt-json` route
 * substitutes the bounded alternate immediately before process launch.
 */
export function selectBridgeImageSources(
  messages: ChatMessage[],
  model: BrokerModel,
): ChatMessage[] {
  const carrier = brokerImageCarrierForModel(model);
  return messages.map((message) => {
    if (
      message.role === "system" ||
      message.role === "tool" ||
      typeof message.content === "string"
    ) {
      return message;
    }

    let changed = false;
    const content: MessagePart[] = message.content.map((part) => {
      if (part.type !== "imageUrl") return part;
      changed = true;
      return {
        type: "imageUrl",
        imageUrl: {
          url:
            carrier === "inline-argv"
              ? (part.imageUrl.inlineArgvUrl ?? part.imageUrl.url)
              : part.imageUrl.url,
        },
      };
    });
    return changed ? { ...message, content } : message;
  });
}

export function materializeBridgeImages(
  messages: ChatMessage[],
  dir: string = bridgeAttachmentDir(),
): ChatMessage[] {
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      latestUserIndex = index;
      break;
    }
  }

  const materialized = messages.map((message, index) => {
    if (message.role !== "user" || typeof message.content === "string") {
      return message;
    }
    if (!message.content.some((part) => part.type === "imageUrl")) {
      return message;
    }
    const inline = index === latestUserIndex;
    const content: MessagePart[] = message.content.map((part) =>
      part.type === "imageUrl"
        ? {
            type: "text",
            text: renderImageReference(part.imageUrl?.url, inline, dir),
          }
        : part,
    );
    return { ...message, content };
  });
  return materialized;
}

/**
 * Materialize one live follow-up for the text-only inbox transport. Image
 * bytes are written exactly as decoded from the original data URL: there is
 * no resize, recompression, re-encoding, or format conversion. The returned
 * text points the native vendor at that original file.
 */
export function materializeBridgeMessageContent(
  content: MessageContent,
  dir: string = bridgeAttachmentDir(),
): string {
  if (typeof content === "string") return content;
  const [message] = materializeBridgeImages([{ role: "user", content }], dir);
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}
