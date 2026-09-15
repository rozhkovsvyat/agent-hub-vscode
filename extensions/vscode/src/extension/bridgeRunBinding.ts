import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ANCESTORS = 12;
const BINDING_TTL_MS = 6 * 60 * 60 * 1000;

export type CukiiRunBinding = {
  version: 2;
  vendorPid: number;
  processStartToken: string;
  sessionId: string;
  runId: string;
  nonce: string;
  createdMs: number;
  expiresMs: number;
};

export type ProcessSnapshot = {
  pid: number;
  parentPid: number;
  startToken: string;
};

export function bridgeBindingRoot(): string {
  return (
    process.env.CUKII_BINDING_DIR ||
    path.join(os.homedir(), ".continue", "cukii-bindings")
  );
}

function linuxSnapshot(pid: number): ProcessSnapshot | undefined {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = text.slice(close + 1).trim().split(/\s+/);
    const parentPid = Number(fields[1]);
    const startToken = fields[19];
    if (!Number.isSafeInteger(parentPid) || !startToken) return undefined;
    return { pid, parentPid, startToken };
  } catch {
    return undefined;
  }
}

function portableSnapshot(pid: number): ProcessSnapshot | undefined {
  const result = spawnSync(
    "ps",
    ["-o", "ppid=", "-o", "lstart=", "-p", String(pid)],
    {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    },
  );
  if (result.status !== 0) return undefined;
  const match = String(result.stdout || "")
    .trim()
    .match(/^(\d+)\s+(.+)$/);
  if (!match) return undefined;
  return {
    pid,
    parentPid: Number(match[1]),
    startToken: match[2].trim().replace(/\s+/g, " "),
  };
}

function startOrder(token: string): bigint | undefined {
  if (/^\d+$/.test(token)) {
    try {
      return BigInt(token);
    } catch {
      return undefined;
    }
  }
  const parsed = Date.parse(token);
  return Number.isFinite(parsed) ? BigInt(parsed) : undefined;
}

/** Every OS parent must have started no later than its observed child. */
export function lineageHasValidStartOrder(lineage: ProcessSnapshot[]): boolean {
  for (let index = 1; index < lineage.length; index += 1) {
    const descendant = startOrder(lineage[index - 1].startToken);
    const ancestor = startOrder(lineage[index].startToken);
    if (descendant === undefined || ancestor === undefined || ancestor > descendant) {
      return false;
    }
  }
  return true;
}

function windowsLineage(startPid: number): ProcessSnapshot[] {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$current = ${startPid}`,
    "$out = @()",
    `for ($i = 0; $i -lt ${MAX_ANCESTORS} -and $current -gt 0; $i++) {`,
    '  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $current"',
    "  if (-not $p) { break }",
    "  $g = Get-Process -Id $current -ErrorAction Stop",
    "  $out += [pscustomobject]@{ pid = [int]$current; parentPid = [int]$p.ParentProcessId; startToken = [string]$g.StartTime.ToUniversalTime().ToFileTimeUtc() }",
    "  $current = [int]$p.ParentProcessId",
    "}",
    "$out | ConvertTo-Json -Compress",
  ].join("\r\n");
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 8_000, windowsHide: true },
  );
  if (result.status !== 0 || !String(result.stdout || "").trim()) return [];
  try {
    const parsed = JSON.parse(String(result.stdout)) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => row as Partial<ProcessSnapshot>)
      .filter(
        (row): row is ProcessSnapshot =>
          Number.isSafeInteger(row.pid) &&
          Number.isSafeInteger(row.parentPid) &&
          typeof row.startToken === "string" &&
          row.startToken.length > 0,
      );
  } catch {
    return [];
  }
}

export function processLineage(startPid: number): ProcessSnapshot[] {
  if (!Number.isSafeInteger(startPid) || startPid <= 0) return [];
  if (process.platform === "win32") return windowsLineage(startPid);
  const result: ProcessSnapshot[] = [];
  const visited = new Set<number>();
  let current = startPid;
  for (let index = 0; index < MAX_ANCESTORS; index += 1) {
    if (current <= 0 || visited.has(current)) break;
    visited.add(current);
    const snapshot = process.platform === "linux"
      ? linuxSnapshot(current)
      : portableSnapshot(current);
    if (!snapshot) break;
    result.push(snapshot);
    current = snapshot.parentPid;
  }
  return result;
}

function bindingPath(pid: number): string {
  return path.join(bridgeBindingRoot(), `${pid}.json`);
}

function validBinding(value: unknown): value is CukiiRunBinding {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<CukiiRunBinding>;
  return (
    item.version === 2 &&
    Number.isSafeInteger(item.vendorPid) &&
    typeof item.processStartToken === "string" &&
    SAFE_SEGMENT.test(item.sessionId ?? "") &&
    SAFE_SEGMENT.test(item.runId ?? "") &&
    /^[a-f0-9]{64}$/.test(item.nonce ?? "") &&
    Number.isSafeInteger(item.createdMs) &&
    Number.isSafeInteger(item.expiresMs)
  );
}

export function readRunBindingForPid(
  pid: number,
  nowMs = Date.now(),
): CukiiRunBinding | undefined {
  try {
    const item = JSON.parse(fs.readFileSync(bindingPath(pid), "utf8"));
    if (!validBinding(item) || item.expiresMs < nowMs) return undefined;
    const live = processLineage(pid)[0];
    if (
      !live ||
      live.pid !== item.vendorPid ||
      live.startToken !== item.processStartToken
    ) {
      return undefined;
    }
    return item;
  } catch {
    return undefined;
  }
}

export function registerRunBinding(
  vendorPid: number,
  sessionId: string,
  runId: string,
  nowMs = Date.now(),
): CukiiRunBinding | undefined {
  if (!SAFE_SEGMENT.test(sessionId) || !SAFE_SEGMENT.test(runId)) return undefined;
  const process = processLineage(vendorPid)[0];
  if (!process || process.pid !== vendorPid) return undefined;
  const record: CukiiRunBinding = {
    version: 2,
    vendorPid,
    processStartToken: process.startToken,
    sessionId,
    runId,
    nonce: randomBytes(32).toString("hex"),
    createdMs: nowMs,
    expiresMs: nowMs + BINDING_TTL_MS,
  };
  const root = bridgeBindingRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = bindingPath(vendorPid);
  const temporary = `${target}.${process.pid}.${nowMs}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // Windows ACLs are authoritative.
  }
  fs.renameSync(temporary, target);
  return record;
}

export function resolveAncestorRunBinding(
  parentPid = process.ppid,
  nowMs = Date.now(),
): CukiiRunBinding | undefined {
  const lineage = processLineage(parentPid);
  for (let index = 0; index < lineage.length; index += 1) {
    if (!lineageHasValidStartOrder(lineage.slice(0, index + 1))) return undefined;
    const process = lineage[index];
    try {
      const item = JSON.parse(fs.readFileSync(bindingPath(process.pid), "utf8"));
      if (
        validBinding(item) &&
        item.vendorPid === process.pid &&
        item.processStartToken === process.startToken &&
        item.createdMs <= nowMs + 5_000 &&
        item.expiresMs >= nowMs
      ) {
        return item;
      }
    } catch {
      // Not every ancestor is owned by Cukii.
    }
  }
  return undefined;
}
