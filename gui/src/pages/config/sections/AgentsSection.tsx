import { useContext } from "react";
import { Button, Card } from "../../../components/ui";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ConfigHeader } from "../components/ConfigHeader";

const NATIVE_AGENTS = [
  {
    id: "deepseek",
    title: "DeepSeek",
    detail: "Bind the current Cukii chat session",
  },
  { id: "claude", title: "Claude", detail: "Native Claude CLI" },
  { id: "codex", title: "Codex", detail: "Native Codex CLI" },
  { id: "grok", title: "Grok", detail: "Native Grok CLI" },
  { id: "cursor", title: "Cursor", detail: "Cursor Agent via WSL" },
] as const;

export function AgentsSection() {
  const ideMessenger = useContext(IdeMessengerContext);

  return (
    <div className="space-y-4">
      <ConfigHeader
        title="Agents"
        subtext="Open broker or worker sessions without leaving Cukii"
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {NATIVE_AGENTS.map((agent) => (
          <Card
            key={agent.id}
            className="flex items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold">{agent.title}</div>
              <div className="text-description text-2xs truncate">
                {agent.detail}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void ideMessenger.request("cukii/openBridgeSession", {
                  agent: agent.id,
                })
              }
            >
              Open
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
