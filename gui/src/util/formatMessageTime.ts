/** HH:MM transcript time shared by the user receipt and the assistant capsule. */
export function formatMessageTime(ms: number | undefined): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms!).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
