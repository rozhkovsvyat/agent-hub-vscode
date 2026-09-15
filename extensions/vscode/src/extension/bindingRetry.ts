export async function resolveWithBoundedRetry<T>(
  resolve: () => T | undefined,
  options: {
    attempts?: number;
    intervalMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T | undefined> {
  const attempts = options.attempts ?? 100;
  const intervalMs = options.intervalMs ?? 50;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((done) => setTimeout(done, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = resolve();
    if (value !== undefined) return value;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  return undefined;
}
