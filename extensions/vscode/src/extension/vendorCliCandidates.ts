import * as os from "os";
import * as path from "path";

/**
 * Windows install locations for vendor CLIs that Cukii actually spawns.
 *
 * 🔴 Single source of truth. This list existed in three places — account
 * detection, permission discovery and the chat adapter — and they drifted:
 * only detection knew about the official `%LOCALAPPDATA%\cursor-agent`
 * installer, so Cursor reported "connected" while every run and every
 * permission probe failed with ENOENT and surfaced as "cursor has no verified
 * permission mode for this noninteractive bridge route."
 *
 * Only spawnable routes belong here. `agent.ps1` ships beside `agent.cmd` but
 * CreateProcess cannot launch a PowerShell script, so listing it would
 * reintroduce the same ENOENT behind a path that exists on disk.
 */
export function windowsVendorCliCandidates(
  program: string,
  userHome: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const paths = path.win32;
  const localAppData =
    env.LOCALAPPDATA ?? paths.join(userHome, "AppData", "Local");
  const programFiles = env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const cursorAppBin = (root: string) =>
    paths.join(root, "Cursor", "resources", "app", "bin", "agent.exe");

  if (program === "grok") {
    return [paths.join(userHome, ".grok", "bin", "grok.exe")];
  }
  if (program === "kimi") {
    return [paths.join(userHome, ".kimi-code", "bin", "kimi.exe")];
  }
  if (program === "agent") {
    return [
      // Official native Windows installer, and the only location present on a
      // stock `cursor-agent` install.
      paths.join(localAppData, "cursor-agent", "agent.cmd"),
      paths.join(userHome, ".cursor", "bin", "agent.exe"),
      cursorAppBin(paths.join(localAppData, "Programs")),
      cursorAppBin(localAppData),
      cursorAppBin(programFiles),
      cursorAppBin(programFilesX86),
    ];
  }
  return [];
}
