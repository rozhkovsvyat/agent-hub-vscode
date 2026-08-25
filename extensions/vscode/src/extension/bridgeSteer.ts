import fs from "node:fs";

let activeSteerPath: string | undefined;

export function steerPromptInstruction(steerPath: string): string {
  return [
    "The user can send messages in the chat WHILE you work.",
    "Those follow-ups are appended to this live file:",
    steerPath,
    "After every tool batch, Read that file.",
    "New USER blocks are steering for the CURRENT task: follow them immediately,",
    "do not wait until you finish, and do not start a separate answer.",
    "An empty file means no new steering yet.",
  ].join(" ");
}

export function beginSteerSession(filePath: string): void {
  activeSteerPath = filePath;
  fs.writeFileSync(filePath, "", "utf8");
}

export function endSteerSession(): void {
  const filePath = activeSteerPath;
  activeSteerPath = undefined;
  if (!filePath) {
    return;
  }
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup of a temp file.
  }
}

export function appendSteerMessage(text: string): boolean {
  if (!activeSteerPath) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  fs.appendFileSync(activeSteerPath, `USER:\n${trimmed}\n\n`, "utf8");
  return true;
}

export function activeSteerFile(): string | undefined {
  return activeSteerPath;
}
