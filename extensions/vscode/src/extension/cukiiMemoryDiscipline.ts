import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
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

const MAX_RULES_BYTES = 64 * 1024;
const MIN_RULES_BYTES = 64;

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

/**
 * Accept only a document that carries both markers.
 *
 * 🔴 Without this an HTML error page, a captive-portal redirect or a 404 body
 * would be appended verbatim to the owner's CLAUDE.md — the file that steers
 * every future session. A broken fetch must leave the machine untouched.
 */
export function parseDisciplineBlock(body: string): string {
  const begin = body.indexOf(CUKII_RULES_BEGIN);
  const end = body.indexOf(CUKII_RULES_END);
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error("Cukii discipline document is missing its markers.");
  }
  const block = body.slice(begin, end + CUKII_RULES_END.length).trim();
  if (block.length < MIN_RULES_BYTES) {
    throw new Error("Cukii discipline document is too short to be real.");
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
 * Splice the block in by marker, never by rewriting the file.
 *
 * The owner keeps hand-written instructions in these files; replacing them to
 * configure memory would trade the whole contract for one of its clauses.
 * Returns the original string unchanged when the block is already current, so
 * the caller can stay silent instead of rewriting on every activation.
 */
export function mergeDisciplineBlock(existing: string, block: string): string {
  const begin = existing.indexOf(CUKII_RULES_BEGIN);
  const end = existing.indexOf(CUKII_RULES_END);
  if (begin >= 0 && end > begin) {
    const head = existing.slice(0, begin);
    const tail = existing.slice(end + CUKII_RULES_END.length);
    const merged = `${head}${block}${tail}`;
    return merged === existing ? existing : merged;
  }
  if (!existing.trim()) return `${block}\n`;
  return `${existing.replace(/\s+$/, "")}\n\n${block}\n`;
}

/** Cut the block out, leaving every hand-written line around it intact. */
export function stripDisciplineBlock(existing: string): string {
  const begin = existing.indexOf(CUKII_RULES_BEGIN);
  const end = existing.indexOf(CUKII_RULES_END);
  if (begin < 0 || end <= begin) return existing;
  const head = existing.slice(0, begin).replace(/\s+$/, "");
  const tail = existing.slice(end + CUKII_RULES_END.length).replace(/^\s+/, "");
  if (!head && !tail) return "";
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
      withOwnerFileLock(target, () => {
        const existing = fs.existsSync(target)
          ? fs.readFileSync(target, "utf8")
          : "";
        const merged = mergeDisciplineBlock(existing, block);
        if (merged === existing) {
          report.unchanged.push(target);
          return;
        }
        writeOwnerFileAtomic(target, merged);
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
      withOwnerFileLock(target, () => {
        const existing = fs.readFileSync(target, "utf8");
        const stripped = stripDisciplineBlock(existing);
        if (stripped === existing) {
          report.unchanged.push(target);
          return;
        }
        writeOwnerFileAtomic(target, stripped);
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
