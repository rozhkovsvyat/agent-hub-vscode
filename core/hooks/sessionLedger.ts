import * as fs from "node:fs";
import * as path from "node:path";

import { getContinueGlobalPath } from "../util/paths";

export type HookSessionLedgerEntry = {
  sessionId: string;
  cwd: string;
  openedAt: string;
  state: "starting" | "started" | "ending";
  startInvocationId: string;
  endInvocationId?: string;
};

/**
 * Durable, deliberately small write-ahead journal for lifecycle hooks.  An
 * unclean extension-host exit leaves an entry behind; Core reconciles it on
 * its next activation before accepting a new chat.
 */
export class HookSessionLedger {
  private readonly filePath: string;

  constructor(
    filePath = path.join(getContinueGlobalPath(), "hook-sessions.json"),
  ) {
    this.filePath = filePath;
  }

  list(): HookSessionLedgerEntry[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    } catch {
      return [];
    }
  }

  open(entry: HookSessionLedgerEntry): void {
    const sessions = this.list().filter(
      (item) => item.sessionId !== entry.sessionId,
    );
    sessions.push(entry);
    this.write(sessions);
  }

  markStarted(sessionId: string): void {
    const entry = this.list().find((item) => item.sessionId === sessionId);
    if (entry) this.open({ ...entry, state: "started" });
  }

  markEnding(sessionId: string, endInvocationId: string): void {
    const entry = this.list().find((item) => item.sessionId === sessionId);
    if (entry) this.open({ ...entry, state: "ending", endInvocationId });
  }

  get(sessionId: string): HookSessionLedgerEntry | undefined {
    return this.list().find((item) => item.sessionId === sessionId);
  }

  close(sessionId: string): void {
    this.write(this.list().filter((item) => item.sessionId !== sessionId));
  }

  private write(sessions: HookSessionLedgerEntry[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, sessions }));
    fs.renameSync(temporary, this.filePath);
  }
}
