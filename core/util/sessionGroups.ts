import * as fs from "fs";
import * as path from "path";

import { getContinueGlobalPath } from "./paths.js";

export interface SessionGroup {
  id: string;
  name: string;
}

export interface SessionGroupState {
  groups: SessionGroup[];
  /** sessionId -> groupId */
  assignments: Record<string, string>;
}

export const EMPTY_SESSION_GROUP_STATE: SessionGroupState = {
  groups: [],
  assignments: {},
};

const FILE_NAME = "session-groups.json";

export function sessionGroupsFilePath(): string {
  return path.join(getContinueGlobalPath(), FILE_NAME);
}

function isStoredGroup(entry: unknown): entry is SessionGroup {
  return (
    !!entry &&
    typeof entry === "object" &&
    typeof (entry as SessionGroup).id === "string" &&
    (entry as SessionGroup).id.length > 0 &&
    typeof (entry as SessionGroup).name === "string"
  );
}

/**
 * Groups live next to the journal DB, not in webview storage: every surface
 * on this host (local window, Remote-SSH window, future panels) must see one
 * identical grouping, and webview localStorage is scoped per window origin.
 */
export function parseStoredSessionGroups(raw: unknown): SessionGroupState {
  if (!raw || typeof raw !== "object") {
    return { ...EMPTY_SESSION_GROUP_STATE };
  }
  const candidate = raw as {
    groups?: unknown;
    assignments?: unknown;
  };
  const groups: SessionGroup[] = Array.isArray(candidate.groups)
    ? candidate.groups.filter(isStoredGroup)
    : [];
  const groupIds = new Set(groups.map((group) => group.id));
  const assignments: Record<string, string> = {};
  if (
    candidate.assignments &&
    typeof candidate.assignments === "object" &&
    !Array.isArray(candidate.assignments)
  ) {
    for (const [sessionId, groupId] of Object.entries(
      candidate.assignments as Record<string, unknown>,
    )) {
      // Drop assignments to unknown groups so a deleted group can never
      // resurrect itself through a stale mapping.
      if (
        typeof sessionId === "string" &&
        typeof groupId === "string" &&
        groupIds.has(groupId)
      ) {
        assignments[sessionId] = groupId;
      }
    }
  }
  return { groups, assignments };
}

export async function loadSessionGroups(): Promise<SessionGroupState> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(sessionGroupsFilePath(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...EMPTY_SESSION_GROUP_STATE };
    }
    // A real I/O failure must not masquerade as "no groups": the caller
    // would then let a per-window cache migrate over a live shared copy.
    throw err;
  }
  // JSON.parse failure throws for the same reason.
  return parseStoredSessionGroups(JSON.parse(raw));
}

export async function saveSessionGroups(
  state: SessionGroupState,
): Promise<void> {
  const sanitized = parseStoredSessionGroups(state);
  const filePath = sessionGroupsFilePath();
  const tmpPath = `${filePath}.tmp`;
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify(sanitized, null, 2),
    "utf8",
  );
  await fs.promises.rename(tmpPath, filePath);
}
