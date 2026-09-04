import type { TabAttention } from "../../redux/slices/tabsSlice";

/**
 * Session-list filters, ported 1:1 from the shipped Claude Code webview
 * (`anthropic.claude-code-2.1.260`, `webview/index.js`). Names, label text,
 * separators and toggle semantics all come from that bundle:
 *
 *   var st0=["needs_input","working","completed"],
 *       nt0={needs_input:"Needs input",working:"Working",completed:"Completed"};
 *   var tt0=["open","closed"], et0={open:"Open",closed:"Closed"};
 *   var Je0="Status", Ze0="Tabs";
 *   jh={activeOnly:!1,statuses:new Set,tabStates:new Set};
 */

export const SESSION_STATUSES = [
  "needs_input",
  "working",
  "completed",
] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  needs_input: "Needs input",
  working: "Working",
  completed: "Completed",
};

export const SESSION_TAB_STATES = ["open", "closed"] as const;
export type SessionTabState = (typeof SESSION_TAB_STATES)[number];

export const SESSION_TAB_STATE_LABELS: Record<SessionTabState, string> = {
  open: "Open",
  closed: "Closed",
};

/** Claude's menu section headings (`Je0` / `Ze0`). */
export const SESSION_STATUS_SECTION = "Status";
export const SESSION_TABS_SECTION = "Tabs";

export type SessionFilters = {
  activeOnly: boolean;
  statuses: Set<SessionStatus>;
  tabStates: Set<SessionTabState>;
};

export type SessionFilterSubject = {
  attention?: TabAttention;
  isOpen: boolean;
};

export type SessionFilterCounts = {
  active: number;
  byStatus: Record<SessionStatus, number>;
  byTabState: Record<SessionTabState, number>;
};

export const SESSION_FILTERS_STORAGE_KEY = "cukii.session-filters.v1";

export function defaultSessionFilters(): SessionFilters {
  return { activeOnly: false, statuses: new Set(), tabStates: new Set() };
}

/**
 * Claude's `TB1(openState, remoteStatus)`: waiting/requires_action is
 * "needs input", running is "working", everything else is "completed".
 * Our equivalent of `openState` is the tab's attention.
 */
export function deriveSessionStatus(
  attention: TabAttention | undefined,
): SessionStatus {
  if (attention === "pending-permission") return "needs_input";
  if (attention === "streaming") return "working";
  return "completed";
}

/** Claude's `GG0(isOpen)`. */
export function sessionTabState(isOpen: boolean): SessionTabState {
  return isOpen ? "open" : "closed";
}

/**
 * Claude's `QG0(openState, remoteStatus)` — `openState === "unread" ||
 * status !== "completed"`. We carry no unread flag, so the count is exactly
 * "needs input or working", which is what the button's own tooltip promises.
 */
export function isSessionActive(attention: TabAttention | undefined): boolean {
  return deriveSessionStatus(attention) !== "completed";
}

/** Claude's `qG0`. */
export function hasSessionFilters(filters: SessionFilters): boolean {
  return (
    filters.activeOnly ||
    filters.statuses.size > 0 ||
    filters.tabStates.size > 0
  );
}

/** Claude's `zG0` — selecting an already-selected entry clears it. */
export function toggleStatusFilter(
  filters: SessionFilters,
  status: SessionStatus,
): SessionFilters {
  const statuses = new Set(filters.statuses);
  if (!statuses.delete(status)) statuses.add(status);
  return { ...filters, statuses };
}

/** Claude's `UG0`. */
export function toggleTabStateFilter(
  filters: SessionFilters,
  tabState: SessionTabState,
): SessionFilters {
  const tabStates = new Set(filters.tabStates);
  if (!tabStates.delete(tabState)) tabStates.add(tabState);
  return { ...filters, tabStates };
}

/** Claude's `VG0`: an empty group means "no constraint", not "match nothing". */
export function matchesSessionFilters(
  filters: SessionFilters,
  subject: SessionFilterSubject,
): boolean {
  if (filters.activeOnly && !isSessionActive(subject.attention)) return false;
  if (
    filters.statuses.size > 0 &&
    !filters.statuses.has(deriveSessionStatus(subject.attention))
  ) {
    return false;
  }
  return (
    filters.tabStates.size === 0 ||
    filters.tabStates.has(sessionTabState(subject.isOpen))
  );
}

/**
 * Claude's `HG0`: counts are taken over the whole (unfiltered, unsearched)
 * list, so a chip never reports the size of its own result.
 */
export function countSessionFilters(
  subjects: SessionFilterSubject[],
): SessionFilterCounts {
  const counts: SessionFilterCounts = {
    active: 0,
    byStatus: { needs_input: 0, working: 0, completed: 0 },
    byTabState: { open: 0, closed: 0 },
  };
  for (const subject of subjects) {
    counts.byStatus[deriveSessionStatus(subject.attention)] += 1;
    counts.byTabState[sessionTabState(subject.isOpen)] += 1;
    if (isSessionActive(subject.attention)) counts.active += 1;
  }
  return counts;
}

/** Number of ticked menu entries; drives the funnel button's "on" state. */
export function countSelectedSessionFilters(filters: SessionFilters): number {
  return filters.statuses.size + filters.tabStates.size;
}

function isStatus(value: unknown): value is SessionStatus {
  return SESSION_STATUSES.includes(value as SessionStatus);
}

function isTabState(value: unknown): value is SessionTabState {
  return SESSION_TAB_STATES.includes(value as SessionTabState);
}

export function parseSessionFilters(raw: string | null): SessionFilters {
  const filters = defaultSessionFilters();
  if (!raw) return filters;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return filters;
  }
  if (!parsed || typeof parsed !== "object") return filters;
  const record = parsed as Record<string, unknown>;
  filters.activeOnly = record.activeOnly === true;
  if (Array.isArray(record.statuses)) {
    for (const value of record.statuses) {
      if (isStatus(value)) filters.statuses.add(value);
    }
  }
  if (Array.isArray(record.tabStates)) {
    for (const value of record.tabStates) {
      if (isTabState(value)) filters.tabStates.add(value);
    }
  }
  return filters;
}

export function serializeSessionFilters(filters: SessionFilters): string {
  return JSON.stringify({
    activeOnly: filters.activeOnly,
    statuses: [...filters.statuses],
    tabStates: [...filters.tabStates],
  });
}

/** Storage can throw outright (private modes, a webview with storage denied). */
export function readSessionFilters(): SessionFilters {
  try {
    return parseSessionFilters(
      localStorage.getItem(SESSION_FILTERS_STORAGE_KEY),
    );
  } catch {
    return defaultSessionFilters();
  }
}

export function writeSessionFilters(filters: SessionFilters): void {
  try {
    localStorage.setItem(
      SESSION_FILTERS_STORAGE_KEY,
      serializeSessionFilters(filters),
    );
  } catch {
    // A dropped preference is better than a sidebar that fails to render.
  }
}
