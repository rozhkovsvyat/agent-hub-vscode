import { readFileSync } from "node:fs";
import { join } from "node:path";

// Normalize line endings: on a Windows checkout the file is CRLF, and the
// multi-line selectors below embed a literal "\n".
const css = readFileSync(join(__dirname, "../../index.css"), "utf8").replace(
  /\r\n/g,
  "\n",
);

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  if (!match) throw new Error(`selector not found: ${selector}`);
  return match[1];
}

describe("ask-question sheet theme (owner: dark bg, white text, orange highlights)", () => {
  it("paints the plugin-dark surface, never the cream pill surface", () => {
    const sheet = block(".cukii-user-question");
    expect(sheet).not.toContain("var(--cukii-surface");
    expect(sheet).toMatch(/background:\s*var\(--cukii-shell-raised/);
    expect(sheet).toMatch(/color:\s*var\(--cukii-on-dark/);
    expect(sheet).toMatch(/border:[^;]*var\(--cukii-line/);
  });

  it("keeps secondary text gray and question text white", () => {
    expect(
      block(
        ".cukii-user-question legend span,\n.cukii-user-question-option small",
      ),
    ).toContain("--cukii-muted");
    expect(block(".cukii-user-question legend strong")).toContain(
      "--cukii-on-dark",
    );
    expect(block(".cukii-user-question-option")).toContain("--cukii-on-dark");
  });

  it("highlights selection and the primary action in brand orange", () => {
    const checked = block(".cukii-user-question-option:has(input:checked)");
    expect(checked).toContain("--cukii-accent-strong");
    expect(checked).toMatch(/rgba\(227,\s*168,\s*103/);
    const submit = block('.cukii-user-question-actions button[type="submit"]');
    expect(submit).toContain("--cukii-primary-action-background");
    expect(submit).toContain("--cukii-primary-action-icon");
    // No VS Code blue selection/button leftovers.
    expect(css).not.toMatch(
      /\.cukii-user-question-option:has\(input:checked\)\s*\{[^}]*#094771/s,
    );
    expect(submit).not.toContain("#0e639c");
  });

  it("colors radios and the other-answer field with the same palette", () => {
    expect(block('.cukii-user-question-option input[type="radio"]')).toContain(
      "--cukii-accent-strong",
    );
    const other = block(".cukii-user-question-other");
    expect(other).toContain("--cukii-shell");
    expect(other).toContain("--cukii-on-dark");
  });
});
