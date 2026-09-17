import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveOwnerFile,
  withOwnerFileLock,
  writeOwnerFileAtomic,
} from "./ownerFileTransaction";

export const CUKII_RULES_BEGIN = "<!-- cukii-memory:begin -->";
export const CUKII_RULES_END = "<!-- cukii-memory:end -->";

/**
 * The box serves the discipline from the same vault the memory itself indexes,
 * so editing the rule updates every machine without republishing the extension.
 */
export const CUKII_RULES_RESOURCE = "client/cukii-memory-rules.md";

/**
 * The same document, shipped inside the VSIX.
 *
 * 🔴 2.0.134 made the box the only source, so one failed request left the
 * machine with working memory and no contract — and the failure was swallowed,
 * which is why nobody could say which request failed. The box still wins when
 * it answers, because editing the vault must keep updating every machine; this
 * copy only guarantees that a network blink cannot cost the discipline.
 */
export const CUKII_BUNDLED_RULES_PATH = ["media", "cukii-memory-rules.md"];

const MAX_RULES_BYTES = 64 * 1024;
const MIN_RULES_BYTES = 64;

/**
 * The one clause the document exists for.
 *
 * Both sources are held to it, because the size floor alone accepts anything
 * with two markers around ten characters. A block that never names the tool it
 * is supposed to mandate is not the discipline, it is silence with markers.
 */
const CUKII_RULES_SENTINEL = "memory_search";

/**
 * 🔴 The install runs on the extension host thread, now on every activation.
 * Another window holding this lock is inside a read-merge-write that takes
 * milliseconds, so a short wait is enough to serialize them; a long one only
 * buys a frozen editor when the holder is already gone. A target missed this
 * way is retried on the next attempt instead of blocking the window.
 */
const DISCIPLINE_LOCK_TIMEOUT_MS = 750;

export type DisciplineInstallReport = {
  written: string[];
  unchanged: string[];
  failed: { target: string; reason: string }[];
};

/**
 * The files each vendor CLI actually reads when a session starts.
 *
 * 🔴 Guessing wrong here produces rules nobody loads, which looks exactly like
 * rules that work. Claude Code reads `~/.claude/CLAUDE.md`, Codex reads
 * `~/.codex/AGENTS.md`, Cursor and Qwen read `~/AGENTS.md`. That is also the
 * exact set the box bootstrap merges into, so a machine set up either way ends
 * up with the same discipline.
 */
export function disciplineTargets(home: string = os.homedir()): string[] {
  return [
    path.join(home, ".claude", "CLAUDE.md"),
    path.join(home, ".codex", "AGENTS.md"),
    path.join(home, "AGENTS.md"),
  ];
}

/** `https://box.cukii.ru/mcp` -> `https://box.cukii.ru/client/cukii-memory-rules.md` */
export function disciplineUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/mcp$/, "")}/${CUKII_RULES_RESOURCE}`;
  return url.toString();
}

type DisciplineSpan = { begin: number; end: number };

/**
 * Marker lines: a whole line, outside fenced code.
 *
 * 🔴 This replaces `indexOf`, which was the defect behind the worst outcome
 * this module can produce. A file that *mentions* a marker — «блок между
 * `<!-- cukii-memory:begin -->` и закрывающим» — read as a file that *carries*
 * one, and the splice then replaced everything from that sentence to the real
 * end marker, deleting the owner's hand-written sections in between. These
 * files are exactly where such a note gets written, so a mention must never
 * count as the block.
 */
function markerLines(text: string): { begins: number[]; ends: number[] } {
  const begins: number[] = [];
  const ends: number[] = [];
  let fenced = false;
  let offset = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      fenced = !fenced;
    } else if (!fenced && trimmed === CUKII_RULES_BEGIN) {
      begins.push(offset);
    } else if (!fenced && trimmed === CUKII_RULES_END) {
      ends.push(offset + line.length);
    }
    offset += line.length + 1;
  }
  return { begins, ends };
}

/**
 * Where the block lives, or nothing when the file does not carry one.
 *
 * 🔴 Anything ambiguous is refused instead of guessed: two blocks, a block
 * whose end marker is missing, an end marker standing before its begin. The
 * old code guessed, and each guess had a victim — a half-written file lost
 * everything after the marker, a stray end marker made every install append
 * another copy that logout could no longer remove. A refusal is reported per
 * target and leaves the file byte-for-byte as the owner left it.
 */
function disciplineSpan(
  text: string,
  subject: string,
): DisciplineSpan | undefined {
  const { begins, ends } = markerLines(text);
  if (begins.length === 0 && ends.length === 0) return undefined;
  if (begins.length === 1 && ends.length === 1 && ends[0] > begins[0]) {
    return { begin: begins[0], end: ends[0] };
  }
  throw new Error(
    `${subject} carries a malformed Cukii block (${begins.length} begin, ${ends.length} end markers); refusing to touch it`,
  );
}

/**
 * Accept only a document that carries the marked discipline.
 *
 * 🔴 Without this an HTML error page, a captive-portal redirect or a 404 body
 * would be appended verbatim to the owner's CLAUDE.md — the file that steers
 * every future session. A broken fetch must leave the machine untouched.
 *
 * Line endings are normalized so the copy from the box and the copy from the
 * VSIX are the same text: otherwise a CRLF asset and an LF response are two
 * different blocks, and every switch between sources rewrites all three files.
 */
export function parseDisciplineBlock(body: string): string {
  const text = body.replace(/\r\n/g, "\n");
  const span = disciplineSpan(text, "Cukii discipline document");
  if (!span) {
    throw new Error("Cukii discipline document is missing its markers.");
  }
  const block = text.slice(span.begin, span.end).trim();
  if (block.length < MIN_RULES_BYTES) {
    throw new Error("Cukii discipline document is too short to be real.");
  }
  if (!block.includes(CUKII_RULES_SENTINEL)) {
    throw new Error(
      `Cukii discipline document never names ${CUKII_RULES_SENTINEL}.`,
    );
  }
  return block;
}

export async function fetchDisciplineBlock(
  endpoint: string,
  token: string,
  httpFetch: typeof fetch = fetch,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await httpFetch(disciplineUrl(endpoint), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Cukii discipline fetch failed: ${response.status}`);
    }
    const body = await response.text();
    if (body.length > MAX_RULES_BYTES) {
      throw new Error("Cukii discipline document is too large.");
    }
    return parseDisciplineBlock(body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the discipline that shipped with the extension.
 *
 * Parsed through the same marker check as the network copy, so a truncated or
 * mangled asset is refused instead of being appended to the owner's contract.
 */
export function bundledDisciplineBlock(extensionPath: string): string {
  const file = path.join(extensionPath, ...CUKII_BUNDLED_RULES_PATH);
  return parseDisciplineBlock(fs.readFileSync(file, "utf8"));
}

/**
 * Splice the block in by marker, never by rewriting the file.
 *
 * The owner keeps hand-written instructions in these files; replacing them to
 * configure memory would trade the whole contract for one of its clauses.
 * Returns the original string unchanged when the block is already current, so
 * the caller can stay silent instead of rewriting on every activation.
 */
export function mergeDisciplineBlock(existing: string, block: string): string {
  const span = disciplineSpan(existing, "This agent file");
  if (span) {
    const merged = `${existing.slice(0, span.begin)}${block}${existing.slice(span.end)}`;
    return merged === existing ? existing : merged;
  }
  if (!existing.trim()) return `${block}\n`;
  return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}

/** Cut the block out, leaving every hand-written line around it intact. */
export function stripDisciplineBlock(existing: string): string {
  const span = disciplineSpan(existing, "This agent file");
  if (!span) return existing;
  const head = existing.slice(0, span.begin).replace(/\s+$/, "");
  const tail = existing.slice(span.end).replace(/^\s+/, "");
  if (!head) return tail;
  return tail ? `${head}\n\n${tail}` : `${head}\n`;
}

/**
 * Put the discipline where the vendor CLIs read it.
 *
 * 🔴 This is the answer to the bootstrap paradox: an agent on a clean machine
 * cannot read the rule "use the shared memory" *from* the shared memory. The
 * rule has to arrive with the connection. Cukii 2.0.133 connected the memory
 * and shipped no discipline, so a fresh Mac had working memory and no contract.
 */
export function installDisciplineBlock(
  block: string,
  home: string = os.homedir(),
  targets: string[] = disciplineTargets(home),
): DisciplineInstallReport {
  const report: DisciplineInstallReport = {
    written: [],
    unchanged: [],
    failed: [],
  };
  for (const target of targets) {
    try {
      const file = resolveOwnerFile(target);
      withOwnerFileLock(
        file,
        () => {
          const existing = fs.existsSync(file)
            ? fs.readFileSync(file, "utf8")
            : "";
          const merged = mergeDisciplineBlock(existing, block);
          if (merged === existing) {
            report.unchanged.push(target);
            return;
          }
          writeOwnerFileAtomic(file, merged);
          report.written.push(target);
        },
        { timeoutMs: DISCIPLINE_LOCK_TIMEOUT_MS },
      );
    } catch (error) {
      report.failed.push({
        target,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}

/**
 * Take the discipline back out when the memory is disconnected.
 *
 * Leaving it would instruct every future session to call tools that are no
 * longer registered — a rule pointing at nothing reads as a broken memory.
 */
export function removeDisciplineBlock(
  home: string = os.homedir(),
  targets: string[] = disciplineTargets(home),
): DisciplineInstallReport {
  const report: DisciplineInstallReport = {
    written: [],
    unchanged: [],
    failed: [],
  };
  for (const target of targets) {
    try {
      if (!fs.existsSync(target)) {
        report.unchanged.push(target);
        continue;
      }
      const file = resolveOwnerFile(target);
      withOwnerFileLock(file, () => {
        const existing = fs.readFileSync(file, "utf8");
        const stripped = stripDisciplineBlock(existing);
        if (stripped === existing) {
          report.unchanged.push(target);
          return;
        }
        writeOwnerFileAtomic(file, stripped);
        report.written.push(target);
      });
    } catch (error) {
      report.failed.push({
        target,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
