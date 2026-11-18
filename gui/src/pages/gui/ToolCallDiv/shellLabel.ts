export type CommandShellLabel = "PowerShell" | "Bash" | "Shell";

function labelFromTrustedMetadata(shell: unknown): CommandShellLabel | undefined {
  if (typeof shell !== "string") return undefined;
  const normalized = shell.trim().toLowerCase();
  if (/^(?:powershell|powershell\.exe|pwsh|pwsh\.exe)$/.test(normalized)) {
    return "PowerShell";
  }
  if (/^(?:bash|bash\.exe|sh|zsh|fish|\/bin\/(?:ba|z)?sh)$/.test(normalized)) {
    return "Bash";
  }
  return normalized ? "Shell" : undefined;
}

const POWERSHELL_VERBS =
  "Add|Clear|Close|Copy|Enter|Exit|Export|Find|Format|Get|Import|Invoke|Join|Measure|Move|New|Open|Out|Read|Receive|Remove|Rename|Resolve|Restart|Resume|Save|Select|Send|Set|Show|Sort|Split|Start|Stop|Suspend|Test|Trace|Update|Wait|Write";

/** Metadata wins. Detection is deliberately conservative when it is absent. */
export function commandShellLabel(
  command: string,
  trustedShell?: unknown,
): CommandShellLabel {
  const explicit = labelFromTrustedMetadata(trustedShell);
  if (explicit) return explicit;

  const trimmed = command.trim();
  const cmdlet = new RegExp(`\\b(?:${POWERSHELL_VERBS})-[A-Za-z][\\w-]*\\b`, "i");
  if (
    /^\$/u.test(trimmed) ||
    /^&\s*['"]?[A-Za-z]:\\/u.test(trimmed) ||
    /^(?:pwsh|powershell)(?:\.exe)?\b/i.test(trimmed) ||
    cmdlet.test(trimmed)
  ) {
    return "PowerShell";
  }

  if (
    /^#!.*\b(?:ba|z)?sh\b/i.test(trimmed) ||
    /^(?:export|source|sudo|chmod|chown|grep|sed|awk|find|ls|cat|rm|cp|mv|mkdir|touch)\b/.test(
      trimmed,
    )
  ) {
    return "Bash";
  }

  return "Shell";
}
