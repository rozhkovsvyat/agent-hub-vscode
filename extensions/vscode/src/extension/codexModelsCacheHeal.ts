import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The native Codex binary refuses to start ("failed to load models cache:
 * missing field `supports_parallel_tool_calls`", exit code 1) when a cached
 * model entry lacks a field its deserializer requires. Another installed
 * Codex/ChatGPT extension shares CODEX_HOME and keeps rewriting the cache
 * without that field, so Cukii heals the file right before every codex bridge
 * launch and again before the single retry instead of trusting one writer.
 */

export type CodexCacheHealOutcome = {
  cachePath: string;
  /** A cache file existed and could be inspected. */
  attempted: boolean;
  /** The cache was rewritten with the missing field(s). */
  healed: boolean;
  repairedModels: number;
  reason:
    | "missing"
    | "clean"
    | "parse-error"
    | "repaired"
    | "write-error"
    | "unreadable";
};

const REQUIRED_FIELD = "supports_parallel_tool_calls";

/** CODEX_HOME (explicit override, then env, else ~/.codex). */
export function resolveCodexHome(homeOverride?: string): string {
  if (homeOverride && homeOverride.trim()) return homeOverride;
  const envHome = process.env.CODEX_HOME;
  if (envHome && envHome.trim()) return envHome.trim();
  return path.join(os.homedir(), ".codex");
}

/**
 * Idempotent, best-effort repair of <CODEX_HOME>/models_cache.json: add
 * `supports_parallel_tool_calls: true` to every model entry that lacks it and
 * replace the file atomically (tmp + rename) so a concurrent codex fetch can
 * only ever observe the old file or the healed one. Never throws.
 */
export function ensureCodexModelsCacheCompatible(
  codexHomeOverride?: string,
): CodexCacheHealOutcome {
  const cachePath = path.join(
    resolveCodexHome(codexHomeOverride),
    "models_cache.json",
  );
  try {
    if (!fs.existsSync(cachePath)) {
      return {
        cachePath,
        attempted: false,
        healed: false,
        repairedModels: 0,
        reason: "missing",
      };
    }
    const raw = fs.readFileSync(cachePath, "utf8");
    let parsed: { models?: unknown };
    try {
      parsed = JSON.parse(raw) as { models?: unknown };
    } catch {
      // A cache the CLI itself cannot parse is left for the CLI to rebuild;
      // a repair attempt must never destroy or mask forensic content.
      return {
        cachePath,
        attempted: true,
        healed: false,
        repairedModels: 0,
        reason: "parse-error",
      };
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.models)) {
      // Unknown shape: leave the file exactly as its writer left it.
      return {
        cachePath,
        attempted: true,
        healed: false,
        repairedModels: 0,
        reason: "clean",
      };
    }
    let repairedModels = 0;
    for (const model of parsed.models) {
      if (
        model &&
        typeof model === "object" &&
        !Object.prototype.hasOwnProperty.call(model, REQUIRED_FIELD)
      ) {
        (model as Record<string, unknown>)[REQUIRED_FIELD] = true;
        repairedModels += 1;
      }
    }
    if (repairedModels === 0) {
      return {
        cachePath,
        attempted: true,
        healed: false,
        repairedModels: 0,
        reason: "clean",
      };
    }
    const tmpPath = `${cachePath}.cukii-${process.pid}-${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      fs.renameSync(tmpPath, cachePath);
    } catch {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        // Nothing left to clean up.
      }
      return {
        cachePath,
        attempted: true,
        healed: false,
        repairedModels: 0,
        reason: "write-error",
      };
    }
    return {
      cachePath,
      attempted: true,
      healed: true,
      repairedModels,
      reason: "repaired",
    };
  } catch {
    return {
      cachePath,
      attempted: false,
      healed: false,
      repairedModels: 0,
      reason: "unreadable",
    };
  }
}

/**
 * Matches the codex CLI's fatal startup complaint about its models cache, in
 * both the raw native wording and Cukii's actionable rewrite of it.
 */
export function isCodexModelsCacheFailure(
  text: string | undefined | null,
): boolean {
  return (
    typeof text === "string" &&
    (/failed to load models cache/i.test(text) ||
      /Codex models cache is missing the field/i.test(text))
  );
}
