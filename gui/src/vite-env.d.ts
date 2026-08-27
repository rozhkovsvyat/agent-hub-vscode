/// <reference types="vite/client" />

interface Window {
  cukiiSurface?: "sidebar" | "chat";
  cukiiPanelId?: string;
  initialSessionId?: string | null;
  cukiiVscode?: {
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
  };
}
