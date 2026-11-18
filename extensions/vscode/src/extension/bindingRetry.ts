export async function resolveWithBoundedRetry<T>(
  resolve: () => T | undefined,
  options: {
    attempts?: number;
    intervalMs?: number;
    timeoutMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T | undefined> {
  const attempts = options.attempts ?? Number.MAX_SAFE_INTEGER;
  const intervalMs = options.intervalMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = resolve();
    if (value !== undefined) return value;
    const remainingMs = deadline - now();
    if (attempt + 1 < attempts && remainingMs > 0) {
      await sleep(Math.min(intervalMs, remainingMs));
    } else {
      break;
    }
  }
  return undefined;
}
