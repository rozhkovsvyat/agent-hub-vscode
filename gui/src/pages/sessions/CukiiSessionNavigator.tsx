import {
  ChevronDownIcon,
  MagnifyingGlassIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { BaseSessionMetadata } from "core";
import type { CukiiOpenChatPanel } from "core/protocol/ideWebview";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styled from "styled-components";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import {
  groupSessions,
  parseSessionGroups,
  type SessionGroupState,
} from "./sessionGroups";
import {
  mergeSessionsWithOpenPanels,
  type CukiiNavigatorSession,
} from "./cukiiSessionMerge";

const STORAGE_KEY = "cukii.session-groups.v1";
const Shell = styled.div`
  min-height: 100%;
  color: var(--vscode-foreground);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
`;
const Action = styled.button`
  display: flex;
  width: 100%;
  height: 56px;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
  border: 0;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  text-align: left;
  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;
const Tools = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  margin: 10px 12px 8px;
`;
const SearchWrap = styled.label`
  position: relative;
  display: block;
  min-width: 0;
`;
const SearchIcon = styled(MagnifyingGlassIcon)`
  position: absolute;
  top: 50%;
  left: 10px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  color: var(--vscode-input-placeholderForeground);
  pointer-events: none;
`;
const Search = styled.input`
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 5px 9px 5px 31px;
  border: 1px solid transparent;
  border-radius: 4px;
  outline: none;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  &::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
  &:focus {
    border-color: var(--vscode-focusBorder);
  }
`;
const GroupInput = styled(Search)`
  padding-left: 9px;
`;
const SmallButton = styled.button`
  display: inline-flex;
  height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-foreground);
  white-space: nowrap;
  cursor: pointer;
  font: inherit;
  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;
const GroupHeader = styled.button`
  display: grid;
  width: calc(100% - 16px);
  height: 30px;
  grid-template-columns: 14px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  margin: 2px 8px 0;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
  text-align: left;
  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;
const Count = styled.span`
  display: inline-flex;
  width: 20px;
  min-width: 20px;
  height: 20px;
  box-sizing: border-box;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 11px;
  font-weight: 500;
`;
const Row = styled.div`
  position: relative;
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  margin: 1px 8px;
  border-radius: 5px;
  &:hover,
  &:focus-within {
    background: var(--vscode-list-hoverBackground);
  }
`;
const SessionButton = styled.button`
  display: grid;
  min-width: 0;
  height: 29px;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  padding: 0 8px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
`;
const SessionTitle = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const Age = styled.span`
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  white-space: nowrap;
`;
const RowActions = styled.div`
  position: absolute;
  top: 0;
  right: 4px;
  display: none;
  height: 29px;
  align-items: center;
  gap: 1px;
  padding-left: 12px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--vscode-list-hoverBackground) 18%
  );
  ${Row}:hover &, ${Row}:focus-within & {
    display: flex;
  }
`;
const RowAction = styled.button`
  display: inline-flex;
  width: 25px;
  height: 25px;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  &:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
  }
`;
const ContextMenu = styled.div`
  position: fixed;
  z-index: 10000;
  width: min(240px, calc(100vw - 16px));
  padding: 4px 0;
  border: 1px solid var(--vscode-widget-border);
  border-radius: 7px;
  background: var(--vscode-menu-background);
  color: var(--vscode-menu-foreground);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
`;
const MenuItem = styled.button`
  display: block;
  width: 100%;
  min-height: 31px;
  padding: 6px 16px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
  &:hover,
  &:focus-visible {
    background: var(--vscode-list-hoverBackground);
  }
`;
const MenuSeparator = styled.div`
  height: 1px;
  margin: 4px 0;
  background: var(--vscode-menu-separatorBackground);
`;

export function formatSessionAge(date: string) {
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return "";
  const hours = Math.max(0, (Date.now() - timestamp) / 36e5);
  if (hours < 1) return `${Math.max(1, Math.floor(hours * 60))}m`;
  if (hours < 24) return `${Math.floor(hours)}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type { CukiiNavigatorSession } from "./cukiiSessionMerge";
export { mergeSessionsWithOpenPanels } from "./cukiiSessionMerge";

type ContextState = {
  session: CukiiNavigatorSession;
  x: number;
  y: number;
} | null;

export default function CukiiSessionNavigator() {
  const messenger = useContext(IdeMessengerContext);
  const [sessions, setSessions] = useState<BaseSessionMetadata[]>([]);
  const [openPanels, setOpenPanels] = useState<CukiiOpenChatPanel[]>([]);
  const [query, setQuery] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [assignNewGroupTo, setAssignNewGroupTo] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [context, setContext] = useState<ContextState>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const contextRef = useRef<HTMLDivElement | null>(null);
  const [groups, setGroups] = useState<SessionGroupState>(() =>
    parseSessionGroups(localStorage.getItem(STORAGE_KEY)),
  );

  const load = useCallback(async () => {
    const [historyResult, panelResult] = await Promise.all([
      messenger.request("history/list", {}),
      messenger.request("cukii/listOpenChatPanels", undefined),
    ]);
    if (historyResult.status === "success") setSessions(historyResult.content);
    if (panelResult.status === "success") setOpenPanels(panelResult.content);
  }, [messenger]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  useWebviewListener(
    "cukii/openChatPanelsChanged",
    async (panels) => {
      setOpenPanels(panels);
      // A panel becomes visible at the same time as its first history/save.
      // Refresh metadata now rather than leaving the new semantic row hidden
      // until the five-second poll fires.
      await load();
    },
    [load],
  );
  useEffect(
    () => localStorage.setItem(STORAGE_KEY, JSON.stringify(groups)),
    [groups],
  );
  useEffect(() => {
    if (!context) return;
    const close = (event: MouseEvent) => {
      if (!contextRef.current?.contains(event.target as Node)) setContext(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContext(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [context]);

  const combinedSessions = useMemo(
    () => mergeSessionsWithOpenPanels(sessions, openPanels),
    [openPanels, sessions],
  );
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

  const assignSession = (sessionId: string, groupId: string) => {
    setGroups((state) => ({
      ...state,
      assignments: { ...state.assignments, [sessionId]: groupId },
    }));
    setContext(null);
  };
  const createGroup = () => {
    const name = groupName.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    setGroups((state) => ({
      groups: [...state.groups, { id, name }],
      assignments: assignNewGroupTo
        ? { ...state.assignments, [assignNewGroupTo]: id }
        : state.assignments,
    }));
    setGroupName("");
    setAssignNewGroupTo(null);
    setAddingGroup(false);
    setContext(null);
  };
  const openSession = (session: CukiiNavigatorSession) =>
    messenger.request("cukii/openChatPanel", {
      panelId: session.openPanelId,
      sessionId: session.sessionId,
      title: session.title,
    });
  const beginRename = (session: CukiiNavigatorSession) => {
    setRenameError(null);
    setRenameDraft(session.title);
    setEditingSessionId(session.sessionId);
  };
  const cancelRename = () => {
    setEditingSessionId(null);
    setRenameDraft("");
  };
  const renameSession = async (session: CukiiNavigatorSession) => {
    const title = renameDraft.trim();
    if (!title || title === session.title) {
      cancelRename();
      return;
    }
    const result = await messenger.request("cukii/renameSession", {
      sessionId: session.sessionId,
      title,
    });
    if (result.status !== "success" || !result.content.ok) {
      setRenameError("Could not rename session. Try again.");
      return;
    }
    // Update both sources immediately. The extension also broadcasts the same
    // title to an already-open chat panel, so neither side needs a reload.
    setSessions((items) =>
      items.map((item) =>
        item.sessionId === session.sessionId ? { ...item, title } : item,
      ),
    );
    setOpenPanels((panels) =>
      panels.map((panel) =>
        panel.sessionId === session.sessionId ? { ...panel, title } : panel,
      ),
    );
    cancelRename();
  };
  const deleteSession = async (session: CukiiNavigatorSession) => {
    await messenger.request("history/delete", { id: session.sessionId });
    setGroups((state) => {
      const assignments = { ...state.assignments };
      delete assignments[session.sessionId];
      return { ...state, assignments };
    });
    await load();
  };
  const openContext = (
    event: React.MouseEvent,
    session: CukiiNavigatorSession,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = Math.min(240, window.innerWidth - 16);
    const x = Math.max(
      8,
      Math.min(event.clientX, window.innerWidth - menuWidth - 8),
    );
    const estimatedHeight = 86 + groups.groups.length * 31;
    const y = Math.max(
      8,
      Math.min(event.clientY, window.innerHeight - estimatedHeight - 8),
    );
    setContext({ session, x, y });
  };

  return (
    <Shell data-testid="cukii-session-navigator">
      <Action
        className="cukii-session-action"
        onClick={() =>
          void messenger.request("cukii/openChatPanel", { forceNew: true })
        }
      >
        <PlusIcon width={16} height={16} /> New session
      </Action>
      <Tools>
        <SearchWrap>
          <SearchIcon />
          <Search
            aria-label="Search sessions"
            placeholder="Search sessions..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </SearchWrap>
        <SmallButton
          className="cukii-session-action"
          onClick={() => setAddingGroup(true)}
        >
          <PlusIcon width={15} height={15} /> New group
        </SmallButton>
      </Tools>
      {addingGroup && (
        <Tools>
          <GroupInput
            autoFocus
            aria-label="Group name"
            placeholder="Group name"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") createGroup();
              if (event.key === "Escape") setAddingGroup(false);
            }}
          />
          <SmallButton className="cukii-session-action" onClick={createGroup}>
            Create
          </SmallButton>
        </Tools>
      )}
      {buckets.map((bucket) => {
        const isCollapsed = Boolean(collapsed[bucket.id]);
        return (
          <div key={bucket.id || "ungrouped"}>
            {bucket.name && (
              <GroupHeader
                className="cukii-session-action"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((state) => ({
                    ...state,
                    [bucket.id]: !state[bucket.id],
                  }))
                }
              >
                <ChevronDownIcon
                  width={13}
                  height={13}
                  style={{
                    transform: isCollapsed ? "rotate(-90deg)" : undefined,
                  }}
                />
                <span>{bucket.name}</span>
                <Count>{bucket.sessions.length}</Count>
              </GroupHeader>
            )}
            {!isCollapsed &&
              bucket.sessions.map((session) => (
                <Row
                  key={session.sessionId}
                  onContextMenu={(event) => openContext(event, session)}
                >
                  <SessionButton
                    className="cukii-session-button"
                    title={session.title}
                    onClick={() => void openSession(session)}
                  >
                    {editingSessionId === session.sessionId ? (
                      <input
                        aria-label={`Rename ${session.title}`}
                        autoFocus
                        value={renameDraft}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => setRenameDraft(event.target.value)}
                        onBlur={() => void renameSession(session)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void renameSession(session);
                          }
                          if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRename();
                          }
                        }}
                      />
                    ) : (
                      <SessionTitle>{session.title || "New session"}</SessionTitle>
                    )}
                    <Age>{formatSessionAge(session.dateCreated)}</Age>
                  </SessionButton>
                  <RowActions>
                    <RowAction
                      className="cukii-session-menu-button"
                      aria-label={`Rename ${session.title}`}
                      title="Rename session"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRename(session);
                      }}
                    >
                      <PencilIcon width={15} height={15} />
                    </RowAction>
                    <RowAction
                      className="cukii-session-menu-button"
                      aria-label={`Delete ${session.title}`}
                      title="Delete session"
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteSession(session);
                      }}
                    >
                      <TrashIcon width={16} height={16} />
                    </RowAction>
                  </RowActions>
                </Row>
              ))}
          </div>
        );
      })}
      {visible.length === 0 && (
        <div
          style={{ padding: 12, color: "var(--vscode-descriptionForeground)" }}
        >
          No sessions found
        </div>
      )}
      {context && (
        <ContextMenu
          ref={contextRef}
          role="menu"
          aria-label={`Session actions for ${context.session.title}`}
          style={{ left: context.x, top: context.y }}
        >
          <MenuItem
            className="cukii-session-menu-button"
            role="menuitem"
            onClick={() =>
              void openSession(context.session).then(() => setContext(null))
            }
          >
            Resume session
          </MenuItem>
          <MenuItem
            className="cukii-session-menu-button"
            role="menuitem"
            onClick={() =>
              void deleteSession(context.session).then(() => setContext(null))
            }
          >
            Delete session
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            className="cukii-session-menu-button"
            role="menuitem"
            onClick={() => {
              setAssignNewGroupTo(context.session.sessionId);
              setAddingGroup(true);
              setContext(null);
            }}
          >
            New group from session
          </MenuItem>
          {groups.groups
            .filter(
              (group) =>
                group.id !== groups.assignments[context.session.sessionId],
            )
            .map((group) => (
              <MenuItem
                className="cukii-session-menu-button"
                role="menuitem"
                key={group.id}
                onClick={() =>
                  assignSession(context.session.sessionId, group.id)
                }
              >
                Move to &quot;{group.name}&quot;
              </MenuItem>
            ))}
          <MenuSeparator />
          <MenuItem
            className="cukii-session-menu-button"
            role="menuitem"
            onClick={() => assignSession(context.session.sessionId, "")}
          >
            Remove from group
          </MenuItem>
        </ContextMenu>
      )}
      {renameError && (
        <div role="alert" className="px-3 py-1 text-xs text-[var(--vscode-errorForeground)]">
          {renameError}
        </div>
      )}
    </Shell>
  );
}
