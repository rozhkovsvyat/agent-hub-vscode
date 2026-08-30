import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(join(process.cwd(), "src", relativePath), "utf8");

describe("Cukii GUI contracts", () => {
  it("scopes cookie stop colors to the stop state while preserving the white square", () => {
    const css = source("index.css");
    const toolbar = source("components/mainInput/InputToolbar.tsx");
    expect(toolbar).toContain('showStop ? "cukii-submit-button--stop" : ""');
    expect(toolbar).toContain('bg-white');
    expect(css).toContain("button.cukii-submit-button--stop");
    expect(css).toContain("background: #E3A867 !important;");
    expect(css).toContain("box-shadow: 0 0 0 1px #C9873F !important;");
    expect(css).toContain("background: #C9873F !important;");
  });

  it("uses the queued/history sizing matrix: compact line, wrapping growth, then inner scroll", () => {
    const css = source("index.css");
    expect(css).toContain(".cukii-user-bubble .cukii-input-box");
    expect(css).toContain("width: fit-content;");
    expect(css).toContain("max-width: min(100%, 640px);");
    expect(css).toContain(".cukii-user-bubble .scroll-container");
    expect(css).toContain("max-height: 9rem;");
    expect(css).toContain("overflow-y: auto !important;");
    expect(css).toContain("overflow-wrap: anywhere;");
  });

  it("matches the measured active Claude loader text while keeping orange exclusive to crumbs", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-spinner-row .cukii-thinking-row");
    const contract = css.slice(start, css.indexOf(".cukii-crumbs", start));
    expect(contract).toContain("color: var(--vscode-foreground, #cccccc);");
    expect(contract).toContain("font-size: 13px;");
    expect(contract).toContain("font-weight: 500;");
    expect(contract).toContain("line-height: 19.5px;");
    expect(contract).not.toContain("#E3A867");
  });
});
