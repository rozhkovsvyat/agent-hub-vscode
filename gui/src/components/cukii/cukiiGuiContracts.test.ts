import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(join(process.cwd(), "src", relativePath), "utf8");

function mountContractRules(pattern: RegExp) {
  const style = document.createElement("style");
  style.dataset.cukiiContract = "true";
  style.textContent = source("index.css").match(pattern)?.join("\n") ?? "";
  document.head.append(style);
}

describe("Cukii GUI contracts", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.head
      .querySelectorAll('style[data-cukii-contract="true"]')
      .forEach((style) => style.remove());
    document.documentElement.style.removeProperty("--vscode-foreground");
    document.documentElement.style.removeProperty(
      "--cukii-primary-action-background",
    );
    document.documentElement.style.removeProperty(
      "--cukii-primary-action-background-hover",
    );
    document.documentElement.style.removeProperty(
      "--cukii-primary-action-icon",
    );
  });

  it("uses shared cookie action tokens for both Start and Stop chips", () => {
    const css = source("index.css");
    const toolbar = source("components/mainInput/InputToolbar.tsx");
    const button = document.createElement("button");
    button.className =
      "bg-primary cukii-submit-button cukii-submit-button--stop";
    document.body.append(button);
    expect(toolbar).toContain('showStop ? "cukii-submit-button--stop" : ""');
    expect(toolbar).toContain("cukii-submit-stop-icon");
    expect(css.lastIndexOf("button.cukii-submit-button--stop")).toBeGreaterThan(
      css.lastIndexOf("button.cukii-submit-button,"),
    );
    const canonicalCss = css.toLowerCase();
    expect(canonicalCss).toContain(
      "--cukii-primary-action-background: #e3a867;",
    );
    expect(canonicalCss).toContain(
      "--cukii-primary-action-background-hover: #c9873f;",
    );
    expect(canonicalCss).toContain("--cukii-primary-action-icon: #5c3a28;");
    expect(canonicalCss).toContain(
      "background: var(--cukii-primary-action-background) !important;",
    );
    expect(canonicalCss).toContain(
      "color: var(--cukii-primary-action-icon) !important;",
    );
    expect(canonicalCss).toContain(
      "background: var(--cukii-primary-action-background-hover) !important;",
    );
    expect(canonicalCss).toContain(
      "background: var(--cukii-primary-action-icon);",
    );
    expect(canonicalCss).not.toMatch(
      /cukii-submit-button[\s\S]{0,900}#(?:f48771|e9775f|fff(?:fff)?)/,
    );
  });

  it("declares cookie-orange focus and semantic invalid-state precedence", () => {
    // JSDOM does not evaluate :focus-within. Assert the canonical stylesheet
    // selector and declarations directly rather than testing a fake pseudo-state.
    const canonicalCss = source("index.css").toLowerCase();
    expect(canonicalCss).toContain(
      ".cukii-main-input-shell .cukii-input-box:focus-within",
    );
    expect(canonicalCss).toContain("border-color: #e3a867 !important;");
    expect(canonicalCss).toContain("box-shadow: 0 0 0 1px #e3a867 !important;");
    expect(canonicalCss).toContain(
      '.cukii-main-input-shell .cukii-input-box[aria-invalid="true"]',
    );
    expect(canonicalCss).toContain(
      "var(--vscode-inputvalidation-errorborder, #be1100)",
    );
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

  it("matches measured active and completed loader typography", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-spinner-row .cukii-thinking-row");
    const contract = css.slice(start, css.indexOf(".cukii-crumbs", start));
    expect(contract).toContain("color: var(--vscode-foreground, #cccccc);");
    expect(contract).toContain("font-size: 13px;");
    expect(contract).toContain("font-weight: 500;");
    expect(contract).toContain("line-height: 19.5px;");
    expect(contract.toLowerCase()).not.toContain("#e3a867");
    mountContractRules(/\.cukii-thinking-summary[^{}]*\{[^{}]*\}/g);
    document.documentElement.style.setProperty(
      "--vscode-foreground",
      "#cccccc",
    );
    const active = document.createElement("div");
    active.className = "cukii-thinking-summary cukii-thinking-summary-active";
    const completed = document.createElement("div");
    completed.className =
      "cukii-thinking-summary cukii-thinking-summary-completed";
    document.body.append(active, completed);
    expect(getComputedStyle(active).color).toContain("rgb(204, 204, 204)");
    expect(getComputedStyle(active).fontSize).toBe("13px");
    expect(getComputedStyle(active).fontWeight).toBe("500");
    expect(getComputedStyle(active).lineHeight).toBe("19.5px");
    expect(getComputedStyle(completed).color).toBe("rgba(204, 204, 204, 0.7)");
    expect(getComputedStyle(completed).fontWeight).toBe("400");
  });

  it("keeps the measured 12px non-overlay loader-to-composer gap", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-spinner-row {");
    const contract = css.slice(
      start,
      css.indexOf(".cukii-spinner-row .cukii-thinking-row", start),
    );
    expect(contract).toContain("margin-bottom: 12px;");
    expect(contract).toContain("margin-top: 6px;");
    expect(contract).not.toContain("40px");
  });

  it("keeps sent one-line bubbles compact and lets only wrapped prose grow", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-user-bubble .cukii-input-box");
    const contract = css.slice(
      start,
      css.indexOf(".cukii-main-input-shell", start),
    );
    expect(contract).toContain("min-height: 0;");
    expect(contract).toContain(".cukii-user-bubble .cukii-input-footer");
    expect(contract).toContain("display: none !important;");
    expect(contract).toContain("white-space: pre-wrap;");
    expect(contract).toContain(".cukii-user-bubble .ProseMirror p");
    expect(contract).toContain("margin: 0;");
    expect(contract).not.toContain("min-height: 78px");
  });

  it("keeps messenger receipts inside a single-line user bubble", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-user-message {");
    const receipt = css.indexOf(".cukii-user-receipt {");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeGreaterThan(start);
    const contract = css.slice(start, receipt + 500);
    expect(contract).toContain("display: inline-block");
    expect(contract).toContain("position: absolute");
    expect(contract).toContain("padding-right: 52px");
    expect(contract).not.toContain("padding-bottom");
  });

  it("uses the exact shared Claude toggle accent and transition", () => {
    mountContractRules(/\.cukii-toggle-(?:track|thumb)[^{}]*\{[^{}]*\}/g);
    const toggle = document.createElement("span");
    toggle.className = "cukii-toggle-track cukii-toggle-track-on";
    document.body.append(toggle);
    const style = getComputedStyle(toggle);
    expect(style.backgroundColor).toBe("rgb(217, 119, 87)");
    expect(style.transition).toContain("150ms");
  });

  it("uses shared command sections, menu selection tokens, and no fake Rewind", () => {
    const toolbar = source("components/mainInput/InputToolbar.tsx");
    const css = source("index.css");
    expect(toolbar).not.toContain('showAction("Rewind")');
    expect(toolbar).not.toContain(">Rewind<");
    expect(toolbar).toContain(
      "<CommandSectionHeader>Context</CommandSectionHeader>",
    );
    expect(toolbar).toContain(
      "<CommandSectionHeader divided>Model</CommandSectionHeader>",
    );
    expect(toolbar).toContain("commandSectionDividerClass");
    const selectionRule = css.slice(
      css.indexOf(".cukii-command-menu-item-active"),
      css.indexOf(".thread-message"),
    );
    expect(selectionRule).toContain("--vscode-menu-selectionBackground");
    expect(selectionRule).toContain("--vscode-menu-selectionForeground");
    expect(selectionRule).not.toContain("--vscode-list-activeSelection");
  });

  it("keeps permission modes on a compact dark or light panel and selected blue", () => {
    const css = source("index.css");
    const panelStart = css.indexOf(".cukii-permission-popover {");
    const panelContract = css.slice(
      panelStart,
      css.indexOf("@media screen and (max-width: 300px)", panelStart),
    );
    expect(panelContract).toContain("padding: 4px;");
    expect(panelContract).toContain(
      "background: var(--vscode-menu-background, #252526) !important;",
    );
    expect(panelContract).toContain("min-height: 48px;");
    expect(panelContract).toContain("background: transparent !important;");
    expect(panelContract).toContain("background: #0e639c !important;");
    expect(panelContract).toContain("color: #ffffff !important;");
    expect(panelContract).toContain('html[data-cukii-panel-tone="light"]');
    expect(panelContract).toContain("#ffffff) !important;");
    expect(panelContract).toContain(".cukii-permission-mode-row:focus-visible");
  });
});
