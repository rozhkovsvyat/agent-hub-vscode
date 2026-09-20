import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const INDEX_CSS = fs.readFileSync(
  path.resolve(__dirname, "../../index.css"),
  "utf8",
).replace(/\r\n/g, "\n");

function ruleFor(selectorSource: string): string {
  const start = INDEX_CSS.indexOf(selectorSource);
  expect(start, `missing selector ${selectorSource}`).toBeGreaterThan(-1);
  const open = INDEX_CSS.indexOf("{", start);
  const close = INDEX_CSS.indexOf("}", open);
  return INDEX_CSS.slice(open, close + 1);
}

describe("report issue focus ring", () => {
  it("gives description and severity fields a visible blue focus border", () => {
    const focused = ruleFor(".cukii-report-field textarea:focus");
    expect(INDEX_CSS).toMatch(/\.cukii-report-field input:focus/);
    expect(INDEX_CSS).toMatch(/\.cukii-report-field select:focus/);
    expect(focused).toMatch(/outline:\s*2px\s+solid\s+var\(--vscode-focusBorder/);
    expect(focused).toMatch(/border-color:\s*var\(--vscode-focusBorder/);
    expect(focused).toMatch(/#007fd4/);
    expect(focused).not.toMatch(/outline:\s*none/);
  });

  it("does not let the global outline:none win over report field focus", () => {
    const globalFocus = ruleFor("*:focus");
    expect(globalFocus).toMatch(/outline:\s*none/);
    const fieldFocus = ruleFor(".cukii-report-field textarea:focus");
    expect(fieldFocus).toMatch(/outline:\s*2px\s+solid/);
  });
});

