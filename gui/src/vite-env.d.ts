/// <reference types="vite/client" />

interface Window {
  cukiiSurface?: "sidebar" | "chat" | "usage";
  cukiiVendor?: import("core/protocol/ideWebview").BrokerVendorId | null;
  cukiiPanelId?: string;
  initialSessionId?: string | null;
  cukiiVscode?: {
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
  };
}
