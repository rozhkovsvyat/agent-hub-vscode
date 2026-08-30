import { spawn } from "node:child_process";

type BridgeChild = {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  once(event: "close", listener: () => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
};

export type TerminationOptions = {
  graceMs?: number;
  forceMs?: number;
  forceKill?: (child: BridgeChild) => void | Promise<void>;
};

function wait(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

async function defaultForceKill(child: BridgeChild): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true },
    );
    await Promise.race([
      new Promise<void>((resolve) => killer.once("close", () => resolve())),
      wait(1_000),
    ]);
    return;
  }
  child.kill("SIGKILL");
}

export async function terminateBridgeChild(
  child: BridgeChild,
  options: TerminationOptions = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const graceMs = options.graceMs ?? 750;
  const forceMs = options.forceMs ?? 1_250;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.kill();
  if (
    (await Promise.race([
      closed.then(() => "closed" as const),
      wait(graceMs),
    ])) === "closed"
  ) {
    return;
  }
  await (options.forceKill ?? defaultForceKill)(child);
  await Promise.race([closed, wait(forceMs)]);
}
