import type { BaseSessionMetadata } from "core";
import type {
  CukiiOpenChatPanel,
  CukiiSessionAttention,
} from "core/protocol/ideWebview";
import type { TabAttention } from "../../redux/slices/tabsSlice";

export type CukiiNavigatorSession = BaseSessionMetadata & {
  openPanelId?: string;
  attention?: TabAttention;
};

/**
 * The sidebar reads a panel's attention when the host reports one. The field
 * is optional on purpose: an older host (or a Remote-SSH pair mid-upgrade)
 * simply reports nothing and every open session reads as "completed".
 *
 * The value is re-validated rather than trusted: on Remote-SSH the host and
 * the webview are two independently installed builds, and a host one version
 * ahead may name a state this bundle has never heard of.
 */
const ATTENTIONS: CukiiSessionAttention[] = [
  "none",
  "streaming",
  "pending-permission",
];

function panelAttention(panel: CukiiOpenChatPanel): TabAttention | undefined {
  const value = panel.attention;
  return value !== undefined && ATTENTIONS.includes(value) ? value : undefined;
}

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
  return sessions.map((session) => {
    const panel = openBySession.get(session.sessionId);
    return {
      ...session,
      openPanelId: panel?.panelId,
      attention: panel ? panelAttention(panel) : undefined,
    };
  });
}
