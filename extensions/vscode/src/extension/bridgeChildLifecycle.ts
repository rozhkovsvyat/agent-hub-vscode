import { spawn } from "node:child_process";

export async function terminateBridgeChild(
  child: ReturnType<typeof spawn>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  child.kill();
  await closed;
}
