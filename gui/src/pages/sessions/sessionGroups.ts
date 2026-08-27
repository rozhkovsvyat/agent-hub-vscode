import type { BaseSessionMetadata } from "core";

export type SessionGroup = { id: string; name: string };
export type SessionGroupState = {
  groups: SessionGroup[];
  assignments: Record<string, string>;
};

export const EMPTY_SESSION_GROUPS: SessionGroupState = {
  groups: [],
  assignments: {},
};

export function parseSessionGroups(raw: string | null): SessionGroupState {
  if (!raw) return EMPTY_SESSION_GROUPS;
  try {
    const value = JSON.parse(raw) as Partial<SessionGroupState>;
    return {
      groups: Array.isArray(value.groups)
        ? value.groups.filter(
            (group): group is SessionGroup =>
              typeof group?.id === "string" && typeof group?.name === "string",
          )
        : [],
      assignments:
        value.assignments && typeof value.assignments === "object"
          ? value.assignments
          : {},
    };
  } catch {
    return EMPTY_SESSION_GROUPS;
  }
}

export function groupSessions<T extends BaseSessionMetadata>(
  sessions: T[],
  state: SessionGroupState,
) {
  const known = new Set(state.groups.map((group) => group.id));
  const buckets = new Map<string, T[]>();
  for (const group of state.groups) buckets.set(group.id, []);
  const ungrouped: T[] = [];
  for (const session of sessions) {
    const groupId = state.assignments[session.sessionId];
    if (groupId && known.has(groupId)) buckets.get(groupId)!.push(session);
    else ungrouped.push(session);
  }
  return [
    ...(ungrouped.length || state.groups.length === 0
      ? [{ id: "", name: "", sessions: ungrouped }]
      : []),
    ...state.groups.map((group) => ({
      ...group,
      sessions: buckets.get(group.id) ?? [],
    })),
  ];
}
