import type { BaseSessionMetadata } from "core";
import type { CukiiOpenChatPanel } from "core/protocol/ideWebview";

export type CukiiNavigatorSession = BaseSessionMetadata & {
  openPanelId?: string;
};

/** Only persisted sessions appear in the sidebar; blank editor tabs are omitted. */
export function mergeSessionsWithOpenPanels(
  sessions: BaseSessionMetadata[],
  openPanels: CukiiOpenChatPanel[],
): CukiiNavigatorSession[] {
  // A duplicated panel notification must not make the sidebar jump from the
  // first editor tab to a later duplicate for the same persisted session.
  const openBySession = new Map<string, CukiiOpenChatPanel>();
  for (const panel of openPanels) {
    if (panel.sessionId && !openBySession.has(panel.sessionId)) {
      openBySession.set(panel.sessionId, panel);
    }
  }
  return sessions.map((session) => ({
    ...session,
    openPanelId: openBySession.get(session.sessionId)?.panelId,
  }));
}
