import { BuiltInToolNames } from "core/tools/builtIn";

const SHELL_NAMES = new Set([
  BuiltInToolNames.RunTerminalCommand,
  "bash",
  "shell",
  "powershell",
  "run_command",
  "run_shell_command",
  "runcommand",
]);

export function isShellToolName(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase();
  if (SHELL_NAMES.has(normalized)) return true;
  return (
    normalized.includes("terminal") ||
    normalized.endsWith("_bash") ||
    normalized.endsWith("_shell")
  );
}

export function shellCommandFromArgs(
  args: Record<string, unknown> | undefined,
): string {
  const value = args?.command ?? args?.cmd ?? args?.script;
  return typeof value === "string" ? value : "";
}
