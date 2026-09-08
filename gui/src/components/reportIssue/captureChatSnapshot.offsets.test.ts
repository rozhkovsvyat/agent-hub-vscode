import { describe, expect, it } from "vitest";
import { sanitizeCukiiSnapshotClone } from "./captureChatSnapshot";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "captureChatSnapshot.ts"), "utf8");

function styleProperties(): string[] {
  const open = source.indexOf("const STYLE_PROPERTIES = [");
  const close = source.indexOf("] as const;", open);
  expect(open).toBeGreaterThan(-1);
  return [...source.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("снимок отчёта воспроизводит раскладку", () => {
  it("копирует смещения позиционированных элементов", () => {
    // Без них элемент сохраняет position, теряет top/right/bottom/left и
    // падает на статическое место: композер уезжал в начало снимка.
    const properties = styleProperties();
    for (const offset of ["top", "right", "bottom", "left"]) {
      expect(properties, `нет ${offset}`).toContain(offset);
    }
    expect(properties).toContain("position");
  });

  it("копирует то, чем рисуются маски и градиенты", () => {
    const properties = styleProperties();
    expect(properties).toContain("background-image");
    expect(properties).toContain("mask-image");
    expect(properties).toContain("-webkit-mask-image");
  });

  it("копирует порядок и обтекание, иначе flex-строки переставляются", () => {
    const properties = styleProperties();
    expect(properties).toContain("order");
    expect(properties).toContain("float");
  });

  it("санитайзер по-прежнему убирает картинки и внешние ссылки", () => {
    const root = document.createElement("div");
    root.innerHTML = `<a href="https://example.com">x</a><img src="https://example.com/a.png">`;
    sanitizeCukiiSnapshotClone(root);
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(root.textContent).toContain("[image omitted]");
  });
});
