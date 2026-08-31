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

  it("lets queued and sent bubbles grow to their full wrapped height", () => {
    const css = source("index.css");
    const bubbleStart = css.indexOf(".cukii-user-bubble .scroll-container");
    const bubbleContract = css.slice(
      bubbleStart,
      css.indexOf(".cukii-user-bubble .ProseMirror", bubbleStart),
    );
    expect(css).toContain(".cukii-user-bubble .cukii-input-box");
    expect(css).toContain("width: fit-content;");
    expect(css).toContain("max-width: min(100%, 640px);");
    expect(bubbleContract).toContain("height: auto !important;");
    expect(bubbleContract).toContain("max-height: none !important;");
    expect(bubbleContract).toContain("overflow: visible !important;");
    expect(bubbleContract).not.toContain("max-height: 9rem;");
    expect(bubbleContract).not.toContain("overflow-y: auto !important;");
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

  it("owns every Load earlier messages visual state without a native white fallback", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-load-earlier {");
    const end = css.indexOf(".cukii-user-row", start);
    const contract = css.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(contract).toContain("background: transparent;");
    expect(contract).toContain("border: 1px solid var(--vscode-widget-border");
    expect(contract).toContain("font-family: inherit;");
    expect(contract).toContain(".cukii-load-earlier:hover:not(:disabled)");
    expect(contract).toContain(".cukii-load-earlier:focus-visible");
    expect(contract).toContain("var(--vscode-focusBorder");
    expect(contract).toContain(".cukii-load-earlier:disabled");
    expect(contract).not.toMatch(/background:\s*(?:white|#fff(?:fff)?)/i);
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

  it("lays a fixed receipt slot inside the bubble without shifting or overlaying content", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-user-row {");
    const metadata = css.indexOf(".cukii-user-metadata {");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(metadata).toBeGreaterThan(start);
    const bubbleContract = css.slice(start, metadata);
    const metadataContract = css.slice(metadata, metadata + 600);
    expect(bubbleContract).toContain("display: flex;");
    expect(bubbleContract).toContain("justify-content: flex-end;");
    expect(bubbleContract).toContain("display: inline-flex;");
    expect(bubbleContract).toContain("flex-direction: column;");
    expect(bubbleContract).toContain("align-items: flex-start;");
    expect(bubbleContract).toContain(".cukii-user-message-bubble");
    expect(bubbleContract).toContain("margin-left: auto;");
    expect(bubbleContract).toContain("max-width: min(100%, 640px);");
    expect(bubbleContract).toContain("display: inline-block;");
    expect(bubbleContract).toContain("position: relative;");
    expect(bubbleContract).toContain("padding-bottom: 17px;");
    expect(metadataContract).toContain("position: absolute;");
    expect(metadataContract).toContain("right: 6px;");
    expect(metadataContract).toContain("bottom: 3px;");
    expect(metadataContract).toContain("width: 46px;");
    expect(metadataContract).toContain("height: 12px;");
    expect(metadataContract).toContain("font-size: 10px;");
    expect(metadataContract).toContain("line-height: 12px;");
  });

  it("keeps right-lane bubbles responsive and leaves the agent timeline left", () => {
    const css = source("index.css");
    const userStart = css.indexOf(".cukii-user-row {");
    const timelineStart = css.indexOf(".cukii-timeline-item {", userStart);
    const contract = css.slice(userStart, timelineStart);
    const proseStart = css.indexOf(".cukii-user-bubble .scroll-container");
    const proseContract = css.slice(proseStart, proseStart + 550);
    expect(contract).toContain("min-width: 0;");
    expect(contract).toContain("max-width: min(100%, 640px);");
    expect(contract).toContain("width: fit-content;");
    expect(contract).toContain("max-width: 100%;");
    expect(proseContract).toContain("overflow-wrap: anywhere;");
    expect(proseContract).toContain("max-height: none !important;");
    expect(proseContract).toContain("overflow: visible !important;");
    const timeline = css.slice(timelineStart, timelineStart + 500);
    expect(timeline).not.toContain("margin-left: auto");
    expect(timeline).not.toContain("justify-content: flex-end");
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

  it("keeps assistant prose and tool rows on the same timeline axis", () => {
    const css = source("index.css");
    expect(css).toMatch(
      /\.cukii-timeline-item \.thread-message \.bg-background\s*\{[\s\S]*?padding-inline:\s*0 !important;/,
    );
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
