import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CUKII_BUNDLED_RULES_PATH,
  CUKII_RULES_BEGIN,
  CUKII_RULES_END,
  bundledDisciplineBlock,
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

const count = (text: string, marker: string): number =>
  text.split(marker).length - 1;

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
    // A marker counts only when it owns its line, so a one-liner mentioning
    // both is not a document with a block — it is prose.
    expect(() =>
      parseDisciplineBlock(`${CUKII_RULES_BEGIN}tiny${CUKII_RULES_END}`),
    ).toThrow(/missing its markers/);
    expect(() =>
      parseDisciplineBlock(`${CUKII_RULES_BEGIN}\nок\n${CUKII_RULES_END}`),
    ).toThrow(/too short/);
    // 🔴 Two markers around anything at all used to be enough. The document
    // has to mandate the tool it exists for, or it installs silence.
    expect(() =>
      parseDisciplineBlock(
        `${CUKII_RULES_BEGIN}\n${"будь хорошим агентом. ".repeat(6)}\n${CUKII_RULES_END}`,
      ),
    ).toThrow(/never names memory_search/);
    expect(parseDisciplineBlock(`noise\n${BLOCK}\ntrailing`)).toBe(BLOCK);
  });

  it("reads the box copy and the shipped copy as the same text", () => {
    // The asset is packed on Windows and served from Linux. Without this the
    // two sources are different blocks, and every switch between them rewrites
    // all three of the owner's files for no reason.
    expect(parseDisciplineBlock(BLOCK.replace(/\n/g, "\r\n"))).toBe(BLOCK);
  });

  it("leaves the owner's sections alone in a file that documents the markers", () => {
    // 🔴 The defect this whole revision exists for. `indexOf` matched the
    // marker inside the owner's own sentence, so the splice ran from that
    // sentence to the real end marker and deleted both sections in between —
    // reproduced on the shipped block, second install, no exotic input.
    const existing = [
      "# Мои правила",
      "",
      "## Память",
      "",
      `Плагин Cukii вклеивает свой блок между \`${CUKII_RULES_BEGIN}\` и закрывающим маркером.`,
      "",
      "Выглядит это так:",
      "",
      "```markdown",
      CUKII_RULES_BEGIN,
      "пример блока",
      CUKII_RULES_END,
      "```",
      "",
      "## 🔴 Санкция даётся один раз",
      "",
      "Сказали «снеси» — снеси, второго вопроса быть не должно.",
      "",
      "## Worktree: граница target",
      "",
      "Временный worktree — только в D:\\Scratch.",
      "",
    ].join("\n");

    const once = mergeDisciplineBlock(existing, BLOCK);
    const twice = mergeDisciplineBlock(once, BLOCK);
    expect(twice).toBe(once);
    for (const text of [once, twice]) {
      expect(text).toContain("Санкция даётся один раз");
      expect(text).toContain("Worktree: граница target");
      expect(text).toContain("Плагин Cukii вклеивает свой блок между");
      expect(text).toContain("пример блока");
      // The mention, the fenced example and exactly one real block.
      expect(count(text, CUKII_RULES_BEGIN)).toBe(3);
    }
    // And the block still comes out cleanly, leaving the mention and the
    // example where the owner wrote them.
    const stripped = stripDisciplineBlock(once);
    expect(stripped).toBe(existing.replace(/\s+$/, "") + "\n");
    expect(stripped).toContain("пример блока");
  });

  it("refuses a half-written block instead of deleting the text after it", () => {
    // Reachable without anyone's mistake: an interrupted write by the macOS
    // bootstrap, or the owner trimming the file by hand.
    const existing = `# head\n\n${CUKII_RULES_BEGIN}\nполовина правил\n\n# owner tail\n`;
    expect(() => mergeDisciplineBlock(existing, BLOCK)).toThrow(
      /1 begin, 0 end/,
    );

    const root = home();
    const claude = path.join(root, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    fs.writeFileSync(claude, existing);
    const report = installDisciplineBlock(BLOCK, root);
    // The file is left byte-for-byte as the owner left it, the reason is
    // reported, and the other two targets are not held hostage by it.
    expect(fs.readFileSync(claude, "utf8")).toBe(existing);
    expect(report.failed.map((entry) => entry.target)).toEqual([claude]);
    expect(report.failed[0].reason).toMatch(/malformed/);
    expect(report.written).toHaveLength(2);
  });

  it("refuses a stray end marker instead of appending another copy", () => {
    // 🔴 With `indexOf` this file failed the `end > begin` test, fell through to
    // the append branch, and grew one more block on every activation — while
    // logout could no longer remove any of them.
    const existing = `# head\n\n${CUKII_RULES_END}\n\n# tail\n`;
    expect(() => mergeDisciplineBlock(existing, BLOCK)).toThrow(
      /0 begin, 1 end/,
    );

    const root = home();
    const agents = path.join(root, "AGENTS.md");
    fs.writeFileSync(agents, existing);
    for (let run = 0; run < 3; run++) installDisciplineBlock(BLOCK, root);
    expect(fs.readFileSync(agents, "utf8")).toBe(existing);
    expect(count(fs.readFileSync(agents, "utf8"), CUKII_RULES_BEGIN)).toBe(0);
    // Two blocks in one file is the same refusal, so logout cannot guess either.
    expect(() => stripDisciplineBlock(`${BLOCK}\n\n${BLOCK}\n`)).toThrow(
      /2 begin, 2 end/,
    );
  });

  it("writes through a symlinked target instead of replacing the link", () => {
    // The owner keeps the source of truth in the vault and links to it, so
    // publishing over the link would leave the real contract without the block
    // and still report success.
    const root = home();
    const real = path.join(root, "vault-CLAUDE.md");
    fs.writeFileSync(real, "# из волта\n");
    const claude = path.join(root, ".claude", "CLAUDE.md");
    fs.mkdirSync(path.dirname(claude), { recursive: true });
    try {
      fs.symlinkSync(real, claude);
    } catch (error) {
      // Creating one needs a privilege on Windows; the guard can only be
      // asserted where symlinks exist at all.
      expect((error as NodeJS.ErrnoException).code).toMatch(/EPERM|EACCES/);
      return;
    }

    installDisciplineBlock(BLOCK, root);
    expect(fs.lstatSync(claude).isSymbolicLink()).toBe(true);
    const target = fs.readFileSync(real, "utf8");
    expect(target).toContain("из волта");
    expect(target).toContain("memory_search");
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

  it("ships a real discipline inside the extension", () => {
    // 🔴 This is the fallback that keeps an unreachable box from costing the
    // whole contract, so its absence has to be a red test and not a machine
    // that quietly comes up without rules.
    const extensionRoot = path.resolve(__dirname, "..", "..");
    const asset = path.join(extensionRoot, ...CUKII_BUNDLED_RULES_PATH);
    expect(fs.existsSync(asset)).toBe(true);

    const block = bundledDisciplineBlock(extensionRoot);
    expect(block.startsWith(CUKII_RULES_BEGIN)).toBe(true);
    expect(block.endsWith(CUKII_RULES_END)).toBe(true);
    // The rules have to name the memory tools; a stub would install silence.
    expect(block).toContain("memory_search");
  });

  it("refuses a bundled asset that lost its markers", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-bundled-"));
    roots.push(root);
    const asset = path.join(root, ...CUKII_BUNDLED_RULES_PATH);
    fs.mkdirSync(path.dirname(asset), { recursive: true });
    fs.writeFileSync(asset, "# rules\n\nno markers here\n");
    expect(() => bundledDisciplineBlock(root)).toThrow(/missing its markers/);
  });
});
