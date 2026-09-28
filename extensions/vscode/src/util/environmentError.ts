type FileSystemErrorLike = {
  code?: unknown;
  syscall?: unknown;
  path?: unknown;
  message?: unknown;
};

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, limit) : undefined;
}

function quotedPathFromMessage(message: string): string | undefined {
  const match = message.match(
    /(?:watch|open|rename|mkdir|write|scandir|access)\s+['"]([^'"\r\n]{1,1024})['"]/iu,
  );
  return match?.[1];
}

/**
 * Turn opaque Node filesystem permission failures into an actionable receipt.
 * The raw error is still logged by the caller; this text is safe for UI.
 */
export function describeCukiiEnvironmentError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as FileSystemErrorLike;
  const message = boundedText(value.message, 4_096) ?? "";
  const code = boundedText(value.code, 32)?.toUpperCase();
  const permissionDenied =
    code === "EPERM" ||
    code === "EACCES" ||
    /\b(?:EPERM|EACCES)\b/u.test(message);
  if (!permissionDenied) return undefined;

  const syscall = (
    boundedText(value.syscall, 64) ??
    message.match(
      /\b(watch|open|rename|mkdir|write|scandir|access)\b/iu,
    )?.[1] ??
    ""
  ).toLowerCase();
  const target =
    boundedText(value.path, 1_024) ??
    quotedPathFromMessage(message) ??
    "the local Cukii data folder";
  const operation =
    syscall === "watch"
      ? `watch “${target}” for changes`
      : /^(?:open|rename|mkdir|write)$/u.test(syscall)
        ? `write Cukii storage at “${target}”`
        : `access “${target}”`;
  const help =
    platform === "win32"
      ? "Allow this path in Windows Controlled Folder Access/antivirus, or grant your Windows account write permission, then reload the window."
      : "Grant your account read/write permission to this path, then reload the window.";
  return `Cukii cannot ${operation}: the operating system denied permission (${code ?? "permission denied"}). ${help}`;
}
