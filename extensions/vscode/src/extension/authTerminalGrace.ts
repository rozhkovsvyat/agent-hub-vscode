/**
 * Closing an auth terminal is not proof that the vendor's credential write is
 * visible yet. Delay that weak signal so the concurrent native-state watcher
 * gets a bounded chance to win the race with an authoritative transition.
 */
export function terminalCloseAfterAuthGrace(
  closed: Promise<"terminal-closed">,
  signal: AbortSignal,
  graceMs = 15_000,
): Promise<"terminal-closed"> {
  return closed.then(
    () =>
      new Promise((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (timer) clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve("terminal-closed");
        };
        if (signal.aborted || graceMs <= 0) return finish();
        signal.addEventListener("abort", finish, { once: true });
        timer = setTimeout(finish, graceMs);
        timer.unref?.();
      }),
  );
}
