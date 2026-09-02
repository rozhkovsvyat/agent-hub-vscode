import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ensureCodexModelsCacheCompatible,
  isCodexModelsCacheFailure,
  resolveCodexHome,
} from "./codexModelsCacheHeal";

const dirs: string[] = [];
const savedCodexHome = process.env.CODEX_HOME;

function makeCodexHome(models?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cukii-codex-heal-"));
  dirs.push(dir);
  if (models !== undefined) {
    writeFileSync(
      path.join(dir, "models_cache.json"),
      JSON.stringify({ models }, null, 2),
      "utf8",
    );
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

describe("ensureCodexModelsCacheCompatible", () => {
  it("leaves a healthy cache byte-for-byte untouched", () => {
    const home = makeCodexHome([
      {
        slug: "gpt-5.6-sol",
        visibility: "list",
        supports_parallel_tool_calls: true,
      },
      {
        slug: "gpt-5.6-terra",
        visibility: "list",
        supports_parallel_tool_calls: false,
      },
    ]);
    const cachePath = path.join(home, "models_cache.json");
    const before = readFileSync(cachePath, "utf8");
    const outcome = ensureCodexModelsCacheCompatible(home);
    expect(outcome).toMatchObject({
      attempted: true,
      healed: false,
      repairedModels: 0,
      reason: "clean",
      cachePath,
    });
    expect(readFileSync(cachePath, "utf8")).toBe(before);
  });

  it("adds the missing deserializer field with default true and keeps everything else", () => {
    const home = makeCodexHome([
      { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list" },
      {
        slug: "gpt-5.6-terra",
        visibility: "list",
        context_window: 272000,
        supports_parallel_tool_calls: false,
      },
    ]);
    const cachePath = path.join(home, "models_cache.json");
    const outcome = ensureCodexModelsCacheCompatible(home);
    expect(outcome).toMatchObject({
      attempted: true,
      healed: true,
      repairedModels: 1,
      reason: "repaired",
    });
    const repaired = JSON.parse(readFileSync(cachePath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    expect(repaired.models).toEqual([
      {
        slug: "gpt-5.6-sol",
        display_name: "GPT-5.6-Sol",
        visibility: "list",
        supports_parallel_tool_calls: true,
      },
      {
        slug: "gpt-5.6-terra",
        visibility: "list",
        context_window: 272000,
        supports_parallel_tool_calls: false,
      },
    ]);
    // The atomic replace leaves no stray temp artefact behind.
    expect(readdirSync(home)).toEqual(["models_cache.json"]);
    // Idempotent: a second pass reports the cache clean and rewrites nothing.
    const before = readFileSync(cachePath, "utf8");
    expect(ensureCodexModelsCacheCompatible(home)).toMatchObject({
      healed: false,
      reason: "clean",
    });
    expect(readFileSync(cachePath, "utf8")).toBe(before);
  });

  it("leaves corrupt JSON alone without throwing", () => {
    const home = makeCodexHome();
    const cachePath = path.join(home, "models_cache.json");
    writeFileSync(cachePath, "{not json", "utf8");
    expect(() => ensureCodexModelsCacheCompatible(home)).not.toThrow();
    expect(ensureCodexModelsCacheCompatible(home)).toMatchObject({
      attempted: true,
      healed: false,
      reason: "parse-error",
    });
    expect(readFileSync(cachePath, "utf8")).toBe("{not json");
  });

  it("reports a missing cache instead of creating one", () => {
    const home = makeCodexHome();
    expect(ensureCodexModelsCacheCompatible(home)).toMatchObject({
      attempted: false,
      healed: false,
      reason: "missing",
    });
    expect(existsSync(path.join(home, "models_cache.json"))).toBe(false);
  });

  it("honors the CODEX_HOME environment override", () => {
    const home = makeCodexHome([{ slug: "gpt-5.6-sol", visibility: "list" }]);
    process.env.CODEX_HOME = home;
    const outcome = ensureCodexModelsCacheCompatible();
    expect(outcome.cachePath).toBe(path.join(home, "models_cache.json"));
    expect(outcome.healed).toBe(true);
  });

  it("prefers the injected home over CODEX_HOME", () => {
    const envHome = makeCodexHome([{ slug: "gpt-5.6-sol" }]);
    const injectedHome = makeCodexHome([{ slug: "gpt-5.6-terra" }]);
    process.env.CODEX_HOME = envHome;
    const outcome = ensureCodexModelsCacheCompatible(injectedHome);
    expect(outcome.cachePath).toBe(
      path.join(injectedHome, "models_cache.json"),
    );
    expect(outcome.healed).toBe(true);
    // The env-pointed cache must stay untouched.
    expect(
      JSON.parse(
        readFileSync(path.join(envHome, "models_cache.json"), "utf8"),
      ).models[0],
    ).toEqual({ slug: "gpt-5.6-sol" });
  });

  it("heals a cache whose models list is not an object array", () => {
    const home = makeCodexHome();
    const cachePath = path.join(home, "models_cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({ models: { "gpt-5.6-sol": { slug: "gpt-5.6-sol" } } }),
      "utf8",
    );
    const before = readFileSync(cachePath, "utf8");
    expect(ensureCodexModelsCacheCompatible(home)).toMatchObject({
      attempted: true,
      healed: false,
      reason: "clean",
    });
    expect(readFileSync(cachePath, "utf8")).toBe(before);
  });
});

describe("resolveCodexHome", () => {
  it("resolves override, env and the default ~/.codex in order", () => {
    expect(resolveCodexHome("D:/explicit")).toBe("D:/explicit");
    process.env.CODEX_HOME = "D:/env-home";
    expect(resolveCodexHome()).toBe("D:/env-home");
    expect(resolveCodexHome("D:/explicit")).toBe("D:/explicit");
    delete process.env.CODEX_HOME;
    expect(resolveCodexHome()).toBe(path.join(homedir(), ".codex"));
  });
});

describe("isCodexModelsCacheFailure", () => {
  it("matches the native startup failure and Cukii's actionable rewrite", () => {
    expect(
      isCodexModelsCacheFailure(
        "ERROR codex_models_manager::manager: failed to load models cache: missing field `supports_parallel_tool_calls` at line 98 column 5",
      ),
    ).toBe(true);
    expect(
      isCodexModelsCacheFailure(
        'GPT-5.6 Sol bridge could not start: the Codex models cache is missing the field "supports_parallel_tool_calls".',
      ),
    ).toBe(true);
    expect(isCodexModelsCacheFailure("rate limit exceeded")).toBe(false);
    expect(isCodexModelsCacheFailure(undefined)).toBe(false);
    expect(isCodexModelsCacheFailure(null)).toBe(false);
  });
});
