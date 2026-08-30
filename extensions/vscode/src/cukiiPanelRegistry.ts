import type * as vscode from "vscode";
import type { VsCodeWebviewProtocol } from "./webviewProtocol";

export const CUKII_BLANK_PANEL_TITLE = "Cukii";

export type CukiiPanelEntry<TPanel> = {
  id: string;
  panel: TPanel;
  sessionId?: string;
  displayTitle?: string;
};

/**
 * Small VS Code-independent registry used by the Cukii editor-tab host.
 * Session lookup is intentionally one-to-one for navigator clicks, while
 * blank tabs remain unlimited and are tracked by their panel id.
 */
export class CukiiPanelRegistry<TPanel> {
  private readonly entries = new Map<string, CukiiPanelEntry<TPanel>>();
  private readonly sessionToPanel = new Map<string, string>();
  private lastActivePanelId?: string;

  add(id: string, panel: TPanel, sessionId?: string): void {
    this.entries.set(id, { id, panel, sessionId });
    if (sessionId) {
      this.sessionToPanel.set(sessionId, id);
    }
    this.lastActivePanelId = id;
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.sessionId && this.sessionToPanel.get(entry.sessionId) === id) {
      this.sessionToPanel.delete(entry.sessionId);
    }
    this.entries.delete(id);
    if (this.lastActivePanelId === id) {
      this.lastActivePanelId = [...this.entries.keys()].at(-1);
    }
  }

  updateSession(id: string, sessionId: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    if (
      entry.sessionId &&
      this.sessionToPanel.get(entry.sessionId) === entry.id
    ) {
      this.sessionToPanel.delete(entry.sessionId);
    }
    entry.sessionId = sessionId;
    this.sessionToPanel.set(sessionId, id);
  }

  updateTitle(id: string, title: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    entry.displayTitle = title;
  }

  markActive(id: string): void {
    if (this.entries.has(id)) {
      this.lastActivePanelId = id;
    }
  }

  forSession(sessionId: string): CukiiPanelEntry<TPanel> | undefined {
    const id = this.sessionToPanel.get(sessionId);
    return id ? this.entries.get(id) : undefined;
  }

  get(id: string): CukiiPanelEntry<TPanel> | undefined {
    return this.entries.get(id);
  }

  values(): CukiiPanelEntry<TPanel>[] {
    return [...this.entries.values()];
  }

  lastActive(): CukiiPanelEntry<TPanel> | undefined {
    return this.lastActivePanelId
      ? this.entries.get(this.lastActivePanelId)
      : undefined;
  }

  get size(): number {
    return this.entries.size;
  }
}

export type CukiiPanelHost = {
  panel: vscode.WebviewPanel;
  protocol: VsCodeWebviewProtocol;
};

type CukiiPanelTitleHost = {
  panel: { title: string };
};

export type CukiiRenameTarget = {
  panelId: string;
  sessionId: string;
  title: string;
};

export const cukiiPanelRegistry = new CukiiPanelRegistry<CukiiPanelHost>();

export function isPersistableCukiiTitle(title?: string): title is string {
  const trimmed = title?.trim();
  return Boolean(trimmed);
}

export function listOpenCukiiPanels<TPanel extends CukiiPanelTitleHost>(
  registry?: CukiiPanelRegistry<TPanel>,
) {
  const panelRegistry =
    registry ?? (cukiiPanelRegistry as unknown as CukiiPanelRegistry<TPanel>);
  return panelRegistry
    .values()
    .filter(
      (entry) => entry.sessionId && isPersistableCukiiTitle(entry.displayTitle),
    )
    .map((entry) => ({
      panelId: entry.id,
      sessionId: entry.sessionId!,
      title: entry.displayTitle!.trim(),
    }));
}

/**
 * Native editor-title context-menu commands do not receive a WebviewPanel
 * identity from VS Code. Keep panel ids in the selection UI so a rename can
 * only target an explicitly chosen, persisted tab — never `lastActive()`.
 */
export function listCukiiRenameTargets<TPanel extends CukiiPanelTitleHost>(
  registry?: CukiiPanelRegistry<TPanel>,
): CukiiRenameTarget[] {
  const panelRegistry =
    registry ?? (cukiiPanelRegistry as unknown as CukiiPanelRegistry<TPanel>);
  return panelRegistry
    .values()
    .filter(
      (entry) => entry.sessionId && isPersistableCukiiTitle(entry.displayTitle),
    )
    .map((entry) => ({
      panelId: entry.id,
      sessionId: entry.sessionId!,
      title: entry.displayTitle!.trim(),
    }));
}

export function getCukiiRenameTarget<TPanel extends CukiiPanelTitleHost>(
  panelId: string,
  registry?: CukiiPanelRegistry<TPanel>,
): CukiiPanelEntry<TPanel> | undefined {
  const panelRegistry =
    registry ?? (cukiiPanelRegistry as unknown as CukiiPanelRegistry<TPanel>);
  const entry = panelRegistry.get(panelId);
  return entry?.sessionId && isPersistableCukiiTitle(entry.displayTitle)
    ? entry
    : undefined;
}

export function syncCukiiPanelTitleForSession<
  TPanel extends CukiiPanelTitleHost,
>(sessionId: string, title: string, registry?: CukiiPanelRegistry<TPanel>) {
  if (!isPersistableCukiiTitle(title)) {
    return;
  }
  const panelRegistry =
    registry ?? (cukiiPanelRegistry as unknown as CukiiPanelRegistry<TPanel>);
  const entry = panelRegistry.forSession(sessionId);
  if (!entry) {
    return;
  }
  entry.displayTitle = title.trim();
  entry.panel.panel.title = title.trim();
}
