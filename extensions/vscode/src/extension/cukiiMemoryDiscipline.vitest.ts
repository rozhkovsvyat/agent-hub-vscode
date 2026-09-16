import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CUKII_RULES_BEGIN,
  CUKII_RULES_END,
  disciplineTargets,
  disciplineUrl,
  fetchDisciplineBlock,
  installDisciplineBlock,
  mergeDisciplineBlock,
  parseDisciplineBlock,
  removeDisciplineBlock,
  stripDisciplineBlock,
} from "./cukiiMemoryDiscipline";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-discipline-"));
  roots.push(root);
  return root;
}

const BLOCK = `${CUKII_RULES_BEGIN}
## Общая память Cukii Box — обязательна

Прежде чем отвечать на вопрос о проектах, прошлых решениях и граблях — вызови
memory_search. Рабочая дисциплина тоже лежит в памяти, подними её сама.
${CUKII_RULES_END}`;

describe("Cukii discipline bootstrap", () => {
  it("targets exactly the files the vendor CLIs read at session start", () => {
    // Claude Code loads ~/.claude/CLAUDE.md, Codex ~/.codex/AGENTS.md, Cursor
    // and Qwen ~/AGENTS.md. A file nobody loads looks like a rule that works.
    const root = home();
    expect(disciplineTargets(root)).toEqual([
      path.join(root, ".claude", "CLAUDE.md"),
      path.join(root, ".codex", "AGENTS.md"),
      path.join(root, "AGENTS.md"),
    ]);
  });

  it("derives the rules resource from the connected MCP endpoint", () => {
    expect(disciplineUrl("https://box.cukii.ru/mcp")).toBe(
      "https://box.cukii.ru/client/cukii-memory-rules.md",
    );
    expect(disciplineUrl("http://127.0.0.1:8780/mcp")).toBe(
      "http://127.0.0.1:8780/client/cukii-memory-rules.md",
    );
  });

  it("refuses a document that is not the marked discipline", () => {
    // 🔴 The dangerous case: a captive portal, a 404 page or an HTML error body
    // would otherwise be appended verbatim to the file that steers every
    // future session.
    expect(() =>
      parseDisciplineBlock("<html><body>404 Not Found</body></html>"),
    ).toThrow(/markers/);
    expect(() => parseDisciplineBlock("")).toThrow(/markers/);
    expect(() =>
      parseDisciplineBlock(`${CUKII_RULES_BEGIN}tiny${CUKII_RULES_END}`),
    ).toThrow(/too short/);
    expect(parseDisciplineBlock(`noise\n${BLOCK}\ntrailing`)).toBe(BLOCK);
  });

  it("keeps the owner's own instructions when it adds the block", () => {
    const existing = "# Мои правила\n\nНе трогать прод по пятницам.\n";
    const merged = mergeDisciplineBlock(existing, BLOCK);
    expect(merged).toContain("Не трогать прод по пятницам.");
    expect(merged).toContain(CUKII_RULES_BEGIN);
    expect(merged.indexOf("Не трогать")).toBeLessThan(
      merged.indexOf(CUKII_RULES_BEGIN),
    );
  });

  it("replaces an outdated block in place without eating the text around it", () => {
    const stale = `${CUKII_RULES_BEGIN}\nстарое правило\n${CUKII_RULES_END}`;
    const existing = `ДО\n\n${stale}\n\nПОСЛЕ\n`;
    const merged = mergeDisciplineBlock(existing, BLOCK);
    expect(merged).toContain("ДО");
    expect(merged).toContain("ПОСЛЕ");
    expect(merged).not.toContain("старое правило");
    expect(merged).toContain("подними её сама");
  });

  it("stays silent when the block is already current", () => {
    const existing = `ДО\n\n${BLOCK}\n\nПОСЛЕ\n`;
    expect(mergeDisciplineBlock(existing, BLOCK)).toBe(existing);
  });

  it("writes the block to disk once and reports the second run as unchanged", () => {
    const root = home();
    const first = installDisciplineBlock(BLOCK, root);
    expect(first.written).toHaveLength(3);
    expect(first.failed).toHaveLength(0);
    for (const target of disciplineTargets(root)) {
      expect(fs.readFileSync(target, "utf8")).toContain("memory_search");
    }
    const second = installDisciplineBlock(BLOCK, root);
    expect(second.written).toHaveLength(0);
    expect(second.unchanged).toHaveLength(3);
  });

  it("takes the block back out on disconnect and leaves the owner's text", () => {
    const root = home();
    const claude = path.join(root, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, "# Мои правила\n\nЛичное.\n");
    installDisciplineBlock(BLOCK, root);
    expect(fs.readFileSync(claude, "utf8")).toContain(CUKII_RULES_BEGIN);

    removeDisciplineBlock(root);
    const after = fs.readFileSync(claude, "utf8");
    expect(after).toContain("Личное.");
    expect(after).not.toContain(CUKII_RULES_BEGIN);
    expect(after).not.toContain("memory_search");
    // A file that held nothing but the block must not be left as blank noise.
    expect(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8")).toBe("");
  });

  it("leaves a file alone when it never carried the block", () => {
    expect(stripDisciplineBlock("# Чужой файл\n")).toBe("# Чужой файл\n");
  });

  it("sends the bearer token and rejects a failed or oversized fetch", async () => {
    const seen: { url: string; auth: string }[] = [];
    const ok = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(input),
          auth: String((init?.headers as Record<string, string>).Authorization),
        });
        return new Response(BLOCK, { status: 200 });
      },
    ) as unknown as typeof fetch;

    expect(
      await fetchDisciplineBlock(
        "https://box.example.test/mcp",
        "t".repeat(40),
        ok,
      ),
    ).toBe(BLOCK);
    expect(seen[0].url).toBe(
      "https://box.example.test/client/cukii-memory-rules.md",
    );
    expect(seen[0].auth).toBe(`Bearer ${"t".repeat(40)}`);

    const denied = vi.fn(
      async () => new Response("no", { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchDisciplineBlock(
        "https://box.example.test/mcp",
        "t".repeat(40),
        denied,
      ),
    ).rejects.toThrow(/401/);

    const huge = vi.fn(
      async () => new Response("x".repeat(65 * 1024), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(
      fetchDisciplineBlock(
        "https://box.example.test/mcp",
        "t".repeat(40),
        huge,
      ),
    ).rejects.toThrow(/too large/);
  });
});
