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
  });

  it("wins the real cascade with cookie stop colors while preserving the white square", () => {
    const css = source("index.css");
    const toolbar = source("components/mainInput/InputToolbar.tsx");
    mountContractRules(/button\.cukii-submit-button[^{}]*\{[^{}]*\}/g);
    const button = document.createElement("button");
    button.className =
      "bg-primary cukii-submit-button cukii-submit-button--stop";
    document.body.append(button);
    expect(toolbar).toContain('showStop ? "cukii-submit-button--stop" : ""');
    expect(toolbar).toContain('bg-white');
    expect(getComputedStyle(button).backgroundColor).toBe("rgb(227, 168, 103)");
    expect(getComputedStyle(button).color).toBe("rgb(255, 255, 255)");
    expect(css.lastIndexOf("button.cukii-submit-button--stop")).toBeGreaterThan(
      css.lastIndexOf("button.cukii-submit-button,"),
    );
    expect(css).toContain("box-shadow: 0 0 0 1px #C9873F !important;");
    expect(css).toContain("background: #C9873F !important;");
  });

  it("uses cookie orange focus, clears it on blur, and lets invalid win", () => {
    mountContractRules(/\.cukii-main-input-shell[^{}]*\{[^{}]*\}/g);
    const shell = document.createElement("div");
    shell.className = "cukii-main-input-shell";
    const box = document.createElement("div");
    box.className = "cukii-input-box";
    const input = document.createElement("input");
    box.append(input);
    shell.append(box);
    document.body.append(shell);

    input.focus();
    expect(getComputedStyle(box).borderColor).toBe("rgb(227, 168, 103)");
    expect(getComputedStyle(box).boxShadow.toLowerCase()).toContain("#e3a867");
    box.setAttribute("aria-invalid", "true");
    expect(getComputedStyle(box).borderColor).toContain(
      "--vscode-inputValidation-errorBorder",
    );
    expect(getComputedStyle(box).boxShadow.toLowerCase()).toContain("#be1100");
    box.removeAttribute("aria-invalid");
    input.blur();
    expect(getComputedStyle(box).borderColor).not.toBe("rgb(227, 168, 103)");
    expect(getComputedStyle(box).boxShadow.toLowerCase()).not.toContain(
      "#e3a867",
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
    expect(contract).not.toContain("#E3A867");
    mountContractRules(/\.cukii-thinking-summary[^{}]*\{[^{}]*\}/g);
    document.documentElement.style.setProperty("--vscode-foreground", "#cccccc");
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
});
