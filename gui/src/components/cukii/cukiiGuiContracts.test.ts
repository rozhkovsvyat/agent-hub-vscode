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

  it("flows the receipt inline after the prose like MAX: no reserved footer, no absolute slot", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-user-row {");
    const metadata = css.indexOf("\n.cukii-user-metadata {");
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
    expect(bubbleContract).toContain("max-width: min(75%, 640px);");
    expect(bubbleContract).toContain("display: inline-block;");
    expect(bubbleContract).toContain("position: relative;");
    // Shared capsule inset: text never hugs either wall.
    expect(bubbleContract).toContain("padding: 7px 12px 6px;");
    // The wrappers between bubble and prose are display:contents so the
    // receipt span shares one inline formatting context with the paragraphs
    // and rises to the last text line whenever it fits.
    expect(bubbleContract).toContain("display: contents !important;");
    expect(bubbleContract).toContain(".cukii-user-bubble .ProseMirror p {");
    expect(bubbleContract).toContain("display: inline;");
    expect(bubbleContract).not.toContain("padding-bottom: 17px;");
    expect(metadataContract).toContain("display: inline-flex;");
    expect(metadataContract).toContain("vertical-align: bottom;");
    expect(metadataContract).toContain("font-size: 10px;");
    expect(metadataContract).toContain("line-height: 12px;");
    expect(metadataContract).not.toContain("position: absolute;");
  });

  it("keeps right-lane bubbles responsive and leaves the agent timeline left", () => {
    const css = source("index.css");
    const userStart = css.indexOf(".cukii-user-row {");
    const timelineStart = css.indexOf(".cukii-timeline-item {", userStart);
    const contract = css.slice(userStart, timelineStart);
    const proseStart = css.indexOf(".cukii-user-bubble .scroll-container");
    const proseContract = css.slice(proseStart, proseStart + 550);
    expect(contract).toContain("min-width: 0;");
    expect(contract).toContain("max-width: min(75%, 640px);");
    expect(contract).toContain("width: fit-content;");
    expect(contract).toContain("max-width: 100%;");
    expect(proseContract).toContain("overflow-wrap: anywhere;");
    expect(proseContract).toContain("max-height: none !important;");
    expect(proseContract).toContain("overflow: visible !important;");
    const timeline = css.slice(timelineStart, timelineStart + 500);
    expect(timeline).not.toContain("margin-left: auto");
    expect(timeline).not.toContain("justify-content: flex-end");
  });

  it("applies MAX grouping geometry: narrow lane, large outer corners, tight group corners, inline short metadata", () => {
    const css = source("index.css");
    const chat = source("pages/gui/Chat.tsx");

    // Lane: right-aligned, noticeably narrower than the column.
    const laneStart = css.indexOf(".cukii-user-message {");
    const laneContract = css.slice(laneStart, laneStart + 320);
    expect(laneContract).toContain("max-width: min(75%, 640px);");
    expect(laneContract).toContain("margin-left: auto;");

    // Bubbles: 16px outer corners; the corner facing an adjacent same-side
    // bubble tightens to 6px. Solo bubbles keep every corner large.
    const bubbleStart = css.indexOf(".cukii-user-message-bubble {");
    const bubbleContract = css.slice(bubbleStart, bubbleStart + 800);
    expect(bubbleContract).toContain("border-radius: 16px;");
    expect(css).toContain(".cukii-user-bubble--group-start {");
    expect(css).toContain(".cukii-user-bubble--group-middle {");
    expect(css).toContain(".cukii-user-bubble--group-end {");
    const groupStart = css.slice(
      css.indexOf(".cukii-user-bubble--group-start {"),
      css.indexOf(".cukii-user-bubble--group-start {") + 120,
    );
    expect(groupStart).toContain("border-bottom-right-radius: 6px;");
    const groupEnd = css.slice(
      css.indexOf(".cukii-user-bubble--group-end {"),
      css.indexOf(".cukii-user-bubble--group-end {") + 120,
    );
    expect(groupEnd).toContain("border-top-right-radius: 6px;");
    expect(css).toContain(".cukii-user-row--grouped {");
    expect(css).toContain("margin-top: 3px;");

    // Receipt flow is pure CSS: no per-message heuristic class, the meta is
    // an inline run-on of the prose for every turn.
    expect(css).not.toContain(".cukii-user-bubble--inline-meta");
    expect(chat).not.toContain("cukii-user-bubble--inline-meta");

    // Chat derives group position from the transcript.
    expect(chat).toContain("cukii-user-bubble--group-middle");
    expect(chat).toContain("cukii-user-bubble--group-start");
    expect(chat).toContain("cukii-user-bubble--group-end");
    expect(chat).toContain("cukii-user-row--grouped");

    // Agent capsules keep shrink-wrapping: short answers hug their content,
    // long ones may fill the column, never exceed it.
    // Comment-stripped slice: prose comments must never shift the contract
    // window away from the declarations it pins.
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const agentStart = flat.indexOf(".cukii-assistant-bubble {");
    const agentContract = flat.slice(agentStart, agentStart + 320);
    expect(agentContract).toContain("width: fit-content;");
    expect(agentContract).toContain("max-width: 100%;");
    expect(agentContract.replace(/max-width/g, "")).not.toContain(
      "width: 100%",
    );
  });

  it("mounts the model pill, Best/All scope toggle and permissions effort row", () => {
    const toolbar = source("components/mainInput/InputToolbar.tsx");
    const modal = source("components/modelSelection/ModelPickerModal.tsx");
    const permissions = source("components/mainInput/PermissionModeControl.tsx");
    const slice = source("redux/slices/sessionSlice.ts");

    // Pill: Claude-style capsule next to the "/" control showing the current
    // broker model, opening the existing picker.
    expect(toolbar).toContain('data-testid="cukii-model-pill"');
    expect(toolbar).toContain("h-[26px]");
    expect(toolbar).toContain("rounded-full");
    expect(toolbar).toContain("px-4");
    expect(toolbar).toContain("onClick={() => setModelPickerOpen(true)}");

    // Scope toggle: a compact knob switch between Best and All labels (not a
    // pair of chunky buttons); Best is the default and the choice lives in
    // session state so every picker entry point and reload shares it.
    expect(modal).toContain("cukii-scope-toggle");
    expect(modal).toContain('data-testid="cukii-scope-switch"');
    expect(modal).toContain("cukii-scope-switch-knob");
    expect(modal).toContain('data-testid="cukii-scope-toggle-best"');
    expect(modal).toContain('data-testid="cukii-scope-toggle-all"');
    expect(modal).toContain("setBrokerModelScope");
    expect(modal).toContain("isBestModel");
    expect(slice).toContain("brokerModelScope: BrokerModelScope;");
    expect(slice).toContain('brokerModelScope: "best",');

    // Effort: ONE shared slider row component rendered in the "/" menu, the
    // model picker footer and the permissions popover — never a second
    // from-scratch control.
    const effortRow = source("components/cukii/CukiiEffortRow.tsx");
    expect(effortRow).toContain('data-testid="cukii-effort-slider"');
    expect(effortRow).toContain("normalizeEffortForModel");
    expect(effortRow).toContain("effortLevelsForModel");
    expect(toolbar).toContain("<CukiiEffortRow");
    expect(modal).toContain("<CukiiEffortRow");
    expect(permissions).toContain("<CukiiEffortRow");
    expect(permissions).toContain('data-testid="cukii-permission-effort-row"');
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

  it("dresses the two messenger capsules in opposite tones", () => {
    const css = source("index.css");

    // User turns wear the cookie-orange of the send/stop buttons with dark ink.
    const userStart = css.indexOf(".cukii-user-bubble .cukii-input-box {");
    const userContract = css.slice(userStart, userStart + 400);
    expect(userContract).toContain("--cukii-primary-action-background");
    expect(css).toMatch(
      /\.cukii-user-bubble \.ProseMirror\s*\{[\s\S]*?color: var\(--cukii-text/,
    );

    // The assistant wears the slate capsule the user turns used to have.
    const botStart = css.indexOf(".cukii-assistant-bubble {");
    expect(botStart).toBeGreaterThanOrEqual(0);
    const botContract = css.slice(botStart, botStart + 400);
    expect(botContract).toContain("--vscode-input-background");
    expect(botContract).toContain("border-radius: 6px;");
    expect(botContract).toContain("width: fit-content;");

    // The capsule keeps its own background and padding: the generic
    // transparency and axis-flush rules must both spare it.
    expect(css).toContain(
      ".thread-message .bg-background:not(.cukii-assistant-bubble)",
    );
    expect(css).toContain(
      ".cukii-timeline-item .bg-background:not(.cukii-assistant-bubble)",
    );
    // Assistant capsules live off the rail entirely: their row is a plain
    // block at the transcript gutter (same inset the user capsule keeps from
    // the right edge), so no dot and no connector line ride along.
    const chat = source("pages/gui/Chat.tsx");
    expect(chat).toContain("cukii-assistant-row shrink-0");
    expect(chat).not.toContain("cukii-timeline-bubble");
    expect(css).toContain(".cukii-assistant-row {");

    // Inline code (paths, guids) keeps no dark square inside the capsule.
    expect(css).toMatch(
      /\.cukii-assistant-bubble \.wmde-markdown code,[\s\S]*?background: transparent !important;/,
    );

    // Checks bottom-align with the time, and the read state is a full check
    // plus a parallel bare stroke — not two overlapping checks.
    expect(css).toMatch(
      /\.cukii-user-metadata \{[\s\S]*?align-items: flex-end;/,
    );
    const receipt = source("components/cukii/CukiiMessageReceiptStatus.tsx");
    expect(receipt).toContain('d="M2 5L5 8L11 2"');
    expect(receipt).toContain('d="M9 8L15 2"');

    // Capsules answer to a right-click copy menu instead of action icons.
    expect(css).toContain(".cukii-message-context-menu {");
    expect(source("components/StepContainer/StepContainer.tsx")).not.toContain(
      "ResponseActions",
    );

    // The markdown canvas never paints a second square inside the capsule.
    expect(css).toMatch(
      /\.cukii-assistant-bubble \.wmde-markdown,[\s\S]*?background-color: transparent !important;/,
    );

    // The reply time flows to the same 6px right inset as the user checks.
    expect(css).toContain(".cukii-assistant-metadata {");

    // The sent capsule wears cookie-orange with dark ink everywhere.
    const flatSent = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const sentStart = flatSent.indexOf(".cukii-user-message-bubble {");
    const sentContract = flatSent.slice(sentStart, sentStart + 400);
    expect(sentContract).toContain("--cukii-primary-action-background");
    expect(css).toMatch(
      /\.cukii-user-message-bubble \.cukii-user-metadata\s*\{\s*color: var\(--cukii-text/,
    );
  });

  it("keeps permission modes on a compact dark or light panel and selected blue", () => {
    const css = source("index.css");
    const panelStart = css.indexOf(".cukii-permission-popover {");
    const panelContract = css.slice(
      panelStart,
      css.indexOf("@media screen and (max-width: 300px)", panelStart),
    );
    expect(panelContract).toContain("padding: 6px 0 4px;");
    expect(panelContract).toContain(
      "background: var(--vscode-menu-background, #252526) !important;",
    );
    expect(panelContract).toContain("min-height: 52px;");
    expect(panelContract).toContain("background: transparent !important;");
    expect(panelContract).toContain("background: rgb(4, 57, 94) !important;");
    expect(panelContract).toContain("color: #ffffff !important;");
    expect(panelContract).toContain('html[data-cukii-panel-tone="light"]');
    expect(panelContract).toContain("#ffffff) !important;");
    expect(panelContract).toContain(".cukii-permission-mode-row:focus-visible");
  });
});
