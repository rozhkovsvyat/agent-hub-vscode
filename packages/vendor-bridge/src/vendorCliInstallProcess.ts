import { spawn, type SpawnOptionsWithoutStdio } from "child_process";
import type { VendorInstallTerminalSpec } from "./vendorCliInstaller";

export type VendorInstallProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export function vendorInstallProcessArgs(
  spec: VendorInstallTerminalSpec,
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === "win32"
    ? [...spec.shellArgs, "-Command", spec.command]
    : [...spec.shellArgs, "-c", spec.command];
}

/**
 * Run a non-interactive vendor installer outside VS Code's terminal UI.
 *
 * An installer is a finite process, not an interactive login flow. Running it
 * in an integrated terminal made stderr disappear when the shell exited and
 * reduced every failure to the same "terminal process ... exit code 1" toast.
 * The caller receives every byte and the actual exit status instead.
 */
export function runVendorInstallProcess(
  spec: VendorInstallTerminalSpec,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onOutput?: (chunk: string) => void;
    platform?: NodeJS.Platform;
  } = {},
): Promise<VendorInstallProcessResult> {
  return new Promise((resolve) => {
    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
    };
    const child = spawn(
      spec.shellPath,
      vendorInstallProcessArgs(spec, options.platform),
      spawnOptions,
    );
    let settled = false;
    const finish = (result: VendorInstallProcessResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const emit = (chunk: Buffer | string) =>
      options.onOutput?.(chunk.toString());
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.once("error", (error) =>
      finish({ exitCode: null, signal: null, error }),
    );
    child.once("close", (exitCode, signal) => finish({ exitCode, signal }));
  });
}
