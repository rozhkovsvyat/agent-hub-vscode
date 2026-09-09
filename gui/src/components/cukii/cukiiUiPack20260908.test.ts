import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const GUI_SRC = join(__dirname, "..", "..");
const css = readFileSync(join(GUI_SRC, "index.css"), "utf8");

function rule(selector: string): string {
  const index = css.indexOf(selector);
  expect(index, `правило ${selector} не найдено`).toBeGreaterThan(-1);
  const open = css.indexOf("{", index);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("подложка sticky-строки берёт фактический холст", () => {
  it("маска красится измеренным цветом, а не токеном поверхности", () => {
    const mask = rule(".cukii-user-row--sticky::before");
    expect(mask).toContain("var(--cukii-canvas, var(--cukii-chat-background))");
    // Прежний дефект: цвет холста назывался вторым токеном и расходился с тем,
    // что реально красит предок ленты.
    expect(mask).not.toContain("sideBar-background");
    expect(mask).not.toContain("editor-background");
  });

  it("мягкий низ сделан альфа-маской, поэтому цвет объявлен ровно один раз", () => {
    const mask = rule(".cukii-user-row--sticky::before");
    expect(mask).toContain("mask-image");
    expect(mask).not.toMatch(/background-image\s*:/);
    const colorStops = mask.match(/var\(--cukii-canvas/g) ?? [];
    expect(colorStops).toHaveLength(1);
  });

  it("сама sticky-строка больше не рисует градиент", () => {
    expect(rule(".cukii-user-row--sticky {")).not.toContain("linear-gradient");
  });

  it("нижний градиент композера подчиняется тому же правилу", () => {
    const fade = rule(".cukii-message-gradient");
    expect(fade).toContain("var(--cukii-canvas, var(--cukii-chat-background))");
    expect(fade).toContain("mask-image");
    expect(fade).not.toMatch(/background-image\s*:\s*linear-gradient/);
  });
});

describe("курсор в пользовательской капсуле", () => {
  it("над телом сообщения курсор обычный", () => {
    expect(rule(".cukii-user-content-shell {")).toContain("cursor: default");
    expect(css).not.toContain("cukii-user-content-shell--clickable");
  });
});

describe("подписи вложений не обрезаются", () => {
  it("строка подписи выше размера шрифта", () => {
    const label = rule(".cukii-user-attachment-label");
    const height = /line-height:\s*(\d+)px/.exec(label)?.[1];
    expect(height, "line-height должен быть задан в px").toBeDefined();
    // 11px UI-текст занимает ~14.6px вместе с выносными элементами.
    expect(Number(height)).toBeGreaterThanOrEqual(15);
  });

  it("плашка не съедает содержимое вертикальными отступами", () => {
    const card = rule(".cukii-user-attachment-card {");
    expect(card).toMatch(/padding:\s*0 /);
    expect(card).toContain("height: 24px");
  });
});

describe("диагностика в карточке достижима без ссылки", () => {
  const reporter = readFileSync(
    join(
      GUI_SRC,
      "..",
      "..",
      "extensions",
      "vscode",
      "src",
      "extension",
      "yougileIssueReporter.ts",
    ),
    "utf8",
  );

  it("URL диагностики попадает в простой текст сообщения", () => {
    // Файл цел: измерено на доставленном отчёте — оба user-data URL отдают
    // HTTP 200, txt весит 6509 байт. Не работает клик по <a> внутри чата,
    // поэтому адрес обязан быть и в простом тексте, где клиент линкует сам.
    expect(reporter).toContain(
      '...(diagnostics?.remoteUrl ? [diagnostics.remoteUrl, ""] : [])',
    );
    expect(reporter).toContain(
      '<p><a href="${escapeHtml(diagnostics.remoteUrl)}">${escapeHtml(diagnostics.remoteUrl)}</a></p>',
    );
  });

  it("в описании карточки рядом с markdown-ссылкой стоит голый URL", () => {
    expect(reporter).toMatch(/\}\) — \$\{file\.remoteUrl as string\}/);
  });
});

describe("композер рисует вложения строкой, а не карточками", () => {
  it("крупные картинки в окне ввода скрыты", () => {
    expect(rule(".cukii-input-box .ProseMirror img")).toContain(
      "display: none",
    );
  });

  it("файловые превью в композере намеренно оставлены", () => {
    expect(css).not.toContain(
      ".cukii-input-box .cukii-file-attachment-node-view",
    );
  });

  it("плашка композера умеет удаляться", () => {
    expect(css).toContain(".cukii-composer-attachment-remove");
  });
});
