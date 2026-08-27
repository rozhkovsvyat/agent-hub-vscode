import type { BaseSessionMetadata } from "core";
import type { CukiiOpenChatPanel } from "core/protocol/ideWebview";
import { useContext, useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import {
  groupSessions,
  parseSessionGroups,
  type SessionGroupState,
} from "./sessionGroups";

const STORAGE_KEY = "cukii.session-groups.v1";
const Shell = styled.div`
  padding: 10px 8px;
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: 13px;
`;
const Action = styled.button`
  width: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  padding: 10px 8px;
  cursor: pointer;
  border-bottom: 1px solid var(--vscode-panel-border);
  font-weight: 600;
  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;
const Tools = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px;
  margin: 10px 0;
`;
const Search = styled.input`
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 7px 9px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  outline: none;
  &:focus {
    border-color: var(--vscode-focusBorder);
  }
`;
const SmallButton = styled.button`
  border: 0;
  border-radius: 4px;
  padding: 6px 8px;
  background: transparent;
  color: var(--vscode-foreground);
  white-space: nowrap;
  cursor: pointer;
  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;
const GroupTitle = styled.div`
  padding: 9px 8px 4px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;
const Row = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  border-radius: 5px;
  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
  select {
    opacity: 0;
    max-width: 22px;
    background: transparent;
    color: inherit;
    border: 0;
  }
  &:hover select,
  &:focus-within select {
    opacity: 1;
    max-width: 95px;
  }
`;
const SessionButton = styled.button`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  padding: 7px 8px;
  cursor: pointer;
`;

function age(date: string) {
  const hours = Math.max(0, (Date.now() - new Date(date).getTime()) / 36e5);
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))}m`;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type CukiiNavigatorSession = BaseSessionMetadata & {
  openPanelId?: string;
};

export function mergeSessionsWithOpenPanels(
  sessions: BaseSessionMetadata[],
  openPanels: CukiiOpenChatPanel[],
): CukiiNavigatorSession[] {
  const openBySession = new Map(
    openPanels
      .filter((panel) => panel.sessionId)
      .map((panel) => [panel.sessionId!, panel]),
  );
  const persistedIds = new Set(sessions.map((session) => session.sessionId));
  const persisted = sessions.map((session) => ({
    ...session,
    openPanelId: openBySession.get(session.sessionId)?.panelId,
  }));
  const liveOnly = openPanels
    .filter((panel) => !panel.sessionId || !persistedIds.has(panel.sessionId))
    .map((panel) => ({
      sessionId: panel.sessionId ?? `open:${panel.panelId}`,
      title: panel.title || "New session",
      dateCreated: new Date().toISOString(),
      workspaceDirectory: window.workspacePaths?.[0] ?? "",
      openPanelId: panel.panelId,
    }));
  return [...liveOnly, ...persisted];
}

export default function CukiiSessionNavigator() {
  const messenger = useContext(IdeMessengerContext);
  const [sessions, setSessions] = useState<BaseSessionMetadata[]>([]);
  const [openPanels, setOpenPanels] = useState<CukiiOpenChatPanel[]>([]);
  const [query, setQuery] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groups, setGroups] = useState<SessionGroupState>(() =>
    parseSessionGroups(localStorage.getItem(STORAGE_KEY)),
  );

  useEffect(() => {
    const load = async () => {
      const [historyResult, panelResult] = await Promise.all([
        messenger.request("history/list", {}),
        messenger.request("cukii/listOpenChatPanels", undefined),
      ]);
      if (historyResult.status === "success") {
        setSessions(historyResult.content);
      }
      if (panelResult.status === "success") {
        setOpenPanels(panelResult.content);
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [messenger]);

  useWebviewListener(
    "cukii/openChatPanelsChanged",
    async (panels) => {
      setOpenPanels(panels);
    },
    [],
  );

  useEffect(
    () => localStorage.setItem(STORAGE_KEY, JSON.stringify(groups)),
    [groups],
  );
  const combinedSessions = useMemo(() => {
    return mergeSessionsWithOpenPanels(sessions, openPanels);
  }, [openPanels, sessions]);

  const visible = useMemo(
    () =>
      combinedSessions.filter((session) =>
        session.title.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [combinedSessions, query],
  );
  const buckets = useMemo(
    () => groupSessions(visible, groups),
    [visible, groups],
  );

  const createGroup = () => {
    const name = groupName.trim();
    if (!name) return;
    setGroups((state) => ({
      ...state,
      groups: [...state.groups, { id: crypto.randomUUID(), name }],
    }));
    setGroupName("");
    setAddingGroup(false);
  };

  return (
    <Shell data-testid="cukii-session-navigator">
      <Action
        onClick={() =>
          void messenger.request("cukii/openChatPanel", { forceNew: true })
        }
      >
        ＋&nbsp; New session
      </Action>
      <Tools>
        <Search
          aria-label="Search sessions"
          placeholder="Search sessions..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SmallButton onClick={() => setAddingGroup(true)}>
          ＋ New group
        </SmallButton>
      </Tools>
      {addingGroup && (
        <Tools>
          <Search
            autoFocus
            placeholder="Group name"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && createGroup()}
          />
          <SmallButton onClick={createGroup}>Create</SmallButton>
        </Tools>
      )}
      {buckets.map((bucket) => (
        <div key={bucket.id || "ungrouped"}>
          {bucket.name && <GroupTitle>{bucket.name}</GroupTitle>}
          {bucket.sessions.map((session) => (
            <Row key={session.sessionId}>
              <SessionButton
                title={session.title}
                onClick={() =>
                  void messenger.request("cukii/openChatPanel", {
                    panelId: session.openPanelId,
                    sessionId: session.sessionId,
                    title: session.title,
                  })
                }
              >
                {session.title || "New session"}{" "}
                <span style={{ float: "right", opacity: 0.65, marginLeft: 8 }}>
                  {session.openPanelId ? "open" : age(session.dateCreated)}
                </span>
              </SessionButton>
              {groups.groups.length > 0 &&
                !session.sessionId.startsWith("open:") && (
                  <select
                    aria-label={`Group for ${session.title}`}
                    value={groups.assignments[session.sessionId] ?? ""}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) =>
                      setGroups((state) => ({
                        ...state,
                        assignments: {
                          ...state.assignments,
                          [session.sessionId]: event.target.value,
                        },
                      }))
                    }
                  >
                    <option value="">No group</option>
                    {groups.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </select>
                )}
            </Row>
          ))}
        </div>
      ))}
      {visible.length === 0 && (
        <div style={{ padding: 12, opacity: 0.65 }}>No sessions found</div>
      )}
    </Shell>
  );
}
