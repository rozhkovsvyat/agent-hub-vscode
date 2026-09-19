import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";

// Line endings are normalised so a multi-line contract assertion means the same
// thing on a CRLF checkout as on an LF one: the working tree here is CRLF, and
// a `\n` literal in an expectation would otherwise silently never match.
const source = (relativePath: string) =>
  readFileSync(join(process.cwd(), "src", relativePath), "utf8").replace(
    /\r\n/g,
    "\n",
  );

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

  it("never revives the removed name-and-email feedback popup", () => {
    const chat = source("pages/gui/Chat.tsx");
    const localStorageContract = source("util/localStorage.ts");

    expect(chat).not.toContain("FeedbackDialog");
    expect(chat).not.toContain("mainTextEntryCounter");
    expect(localStorageContract).not.toContain("mainTextEntryCounter");
    expect(() => source("components/dialogs/FeedbackDialog.tsx")).toThrow();
  });

  it("keeps the issue form compact and single-scroll at every viewport", () => {
    const css = source("index.css");
    const modal = source("components/reportIssue/ReportIssueModal.tsx");
    const dialogStart = css.indexOf(".cukii-report-dialog {");
    const dialog = css.slice(dialogStart, css.indexOf("}", dialogStart) + 1);
    const bodyStart = css.indexOf(".cukii-report-body {");
    const body = css.slice(bodyStart, css.indexOf("}", bodyStart) + 1);

    expect(dialog).toContain("width: min(480px, 100%);");
    expect(dialog).toContain("max-height: min(680px, 100%);");
    expect(body).toContain("overflow-x: hidden;");
    expect(body).toContain("overflow-y: auto;");
    expect(body).toContain("scrollbar-gutter: stable;");
    expect(modal).toContain("rows={2}");
    expect(modal).not.toContain("overflow-y-auto");
    expect(modal).not.toContain("w-[520px]");
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
    const submitRuleStart = canonicalCss.indexOf("button.cukii-submit-button,");
    const submitRules = canonicalCss.slice(
      submitRuleStart,
      canonicalCss.indexOf(".cukii-command-menu", submitRuleStart),
    );
    expect(submitRules).not.toMatch(/#(?:f48771|e9775f|fff(?:fff)?)/);
  });

  it("uses the message-capsule radius for the composer and Start/Stop", () => {
    const css = source("index.css");
    const assistantStart = css.indexOf(".cukii-assistant-bubble {");
    const assistantRule = css.slice(
      assistantStart,
      css.indexOf("}", assistantStart) + 1,
    );
    const composerStart = css.indexOf(
      ".cukii-main-input-shell .cukii-input-box {",
    );
    const composerRule = css.slice(
      composerStart,
      css.indexOf("}", composerStart) + 1,
    );
    const submitStart = css.lastIndexOf("button.cukii-submit-button,");
    const submitRule = css.slice(submitStart, css.indexOf("}", submitStart) + 1);

    expect(assistantRule).toContain("border-radius: 16px;");
    expect(composerRule).toContain("border-radius: 16px !important;");
    expect(submitRule).toContain("border-radius: 16px !important;");
    expect(css).toMatch(
      /\.cukii-icon-button,\s*\.cukii-submit-button\s*\{[^}]*border-radius:\s*16px !important/s,
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

  it("caps the live composer at Claude's measured 200px content viewport", () => {
    const css = source("index.css");
    const start = css.indexOf(
      ".cukii-main-input-shell .cukii-editor-stack > .scroll-container",
    );
    const contract = css.slice(start, css.indexOf("}", start) + 1);
    const editorSource = source(
      "components/mainInput/TipTapEditor/TipTapEditor.tsx",
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(contract).toContain("box-sizing: content-box;");
    expect(contract).toContain("min-height: 1.5em;");
    expect(contract).toContain("max-height: 200px;");
    expect(contract).toContain("overflow-y: auto;");
    expect(contract).toContain("scrollbar-gutter: stable;");
    expect(contract).toContain("padding: 10px 36px 10px 14px;");
    expect(editorSource).not.toContain("max-h-[70vh]");
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

  it("uses the Claude overlay composer and a measured streaming spacer", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-spinner-row {");
    const contract = css.slice(
      start,
      css.indexOf(".cukii-spinner-row .cukii-thinking-row", start),
    );
    expect(contract).toContain("margin-bottom: 0;");
    expect(contract).toContain("margin-top: 6px;");
    expect(css).toContain(".cukii-composer-spacer {");
    expect(css).toContain(".cukii-message-gradient {");
    expect(css).toContain("height: 150px;");
    const gradientRule =
      css.match(/^\.cukii-message-gradient \{[^}]*\}/m)?.[0] ?? "";
    expect(gradientRule).toContain("--cukii-chat-background");
    expect(gradientRule).not.toMatch(
      /transparent 0%,\s*var\(--vscode-editor-background/,
    );
    expect(css).toMatch(
      /\.cukii-main-input-shell \{[\s\S]*?position: absolute;[\s\S]*?right: 16px;[\s\S]*?bottom: 16px;[\s\S]*?left: 16px;[\s\S]*?max-width: 680px;/,
    );
  });

  it("paginates history with a zero-height sentinel instead of a Load earlier button", () => {
    const css = source("index.css");
    const chat = source("pages/gui/Chat.tsx");
    expect(css).toContain(".cukii-history-sentinel");
    expect(chat).toContain("cukii-history-sentinel");
    expect(chat).not.toMatch(/Load earlier messages/);
    expect(chat).toContain("stickySafeTranscriptStart");
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

  it("anchors the receipt in the bubble corner and reserves it with an inline spacer like MAX", () => {
    const css = source("index.css");
    const start = css.indexOf(".cukii-user-row {");
    const metadata = css.indexOf("\n.cukii-user-metadata {");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(metadata).toBeGreaterThan(start);
    const bubbleContract = css.slice(start, metadata);
    const metadataContract = css.slice(metadata, metadata + 700);
    expect(bubbleContract).toContain("display: flex;");
    expect(bubbleContract).toContain("justify-content: flex-end;");
    expect(bubbleContract).toContain("flex-direction: column;");
    expect(bubbleContract).toContain("margin-left: auto;");
    expect(bubbleContract).toContain("max-width: 70%;");
    expect(bubbleContract).toContain(".cukii-user-message-bubble");
    expect(bubbleContract).toContain("position: relative;");
    expect(bubbleContract).toContain("padding: 8px 10px 10px;");
    expect(bubbleContract).toContain("border-radius: 16px;");
    // MAX mechanism: the meta sits absolutely in the bottom-right corner
    // while an inline ::after spacer at the end of the prose reserves its
    // width, so the meta rides the last text line whenever it fits and
    // drops below the text when it does not.
    expect(bubbleContract).toContain("--cukii-meta-reserve: 0px;");
    expect(bubbleContract).toContain(
      ".cukii-user-bubble--meta-inline .ProseMirror p:last-child::after",
    );
    expect(bubbleContract).toContain("display: inline-block;");
    expect(bubbleContract).toContain("height: 14px;");
    // The fragile display:contents chain is gone for good.
    expect(bubbleContract).not.toContain("display: contents !important;");
    expect(metadataContract).toContain("position: static;");
    expect(metadataContract).toContain("width: fit-content;");
    expect(metadataContract).toContain("margin: 2px 0 -6px auto;");
    expect(css).toContain(
      ".cukii-user-bubble--meta-inline > .cukii-user-metadata",
    );
    expect(css).toMatch(
      /\.cukii-user-bubble--meta-inline > \.cukii-user-metadata \{[\s\S]*?position: absolute;/,
    );
    expect(metadataContract).toContain("right: 10px;");
    expect(metadataContract).toContain("bottom: 4px;");
    expect(metadataContract).toContain("align-items: center;");
    expect(metadataContract).toContain("font-size: 11px;");
    expect(metadataContract).toContain("line-height: 14px;");
  });

  it("keeps right-lane bubbles responsive and leaves the agent timeline left", () => {
    const css = source("index.css");
    const userStart = css.indexOf(".cukii-user-row {");
    const timelineStart = css.indexOf(".cukii-timeline-item {", userStart);
    const contract = css.slice(userStart, timelineStart);
    const proseStart = css.indexOf(".cukii-user-bubble .scroll-container");
    const proseContract = css.slice(proseStart, proseStart + 550);
    expect(contract).toContain("min-width: 0;");
    expect(contract).toContain("max-width: 70%;");
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

    // Lane: right-aligned, MAX measures the sent bubble at 70% of the column.
    const laneContract =
      css.match(/^\.cukii-user-message \{[^}]*\}/m)?.[0] ?? "";
    expect(laneContract).toContain("max-width: 70%;");
    expect(laneContract).toContain("margin-left: auto;");

    // Bubbles: 16px outer corners; the corner facing an adjacent same-side
    // bubble tightens to 6px. Solo bubbles keep every corner large.
    // Comment-stripped slice: prose comments must never push a pinned
    // declaration out of the contract window.
    const flatGroup = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const bubbleContract =
      flatGroup.match(/^\.cukii-user-message-bubble \{[^}]*\}/m)?.[0] ?? "";
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
    expect(css).toContain(".cukii-user-row--group-start,");
    expect(css).toContain(".cukii-user-row--group-middle {");
    expect(css).toContain("--cukii-user-row-padding-bottom: 0px");
    expect(css).toContain("--cukii-user-row-padding-top: 0px");
    expect(css).not.toContain(".cukii-user-row--grouped {");

    // Receipt flow stays stylesheet-driven: Chat only flags which receipts
    // exist (time, ticks); the absolute-meta + inline-spacer layout is pure
    // CSS. The old per-message inline-meta heuristic class must never return.
    expect(css).not.toContain(".cukii-user-bubble--inline-meta");
    expect(chat).not.toContain("cukii-user-bubble--inline-meta");
    expect(css).toContain("--cukii-meta-reserve");
    expect(chat).toContain("cukii-user-bubble--with-receipt");
    expect(chat).toContain("cukii-user-bubble--receipt-checks");

    // Chat derives group position from the transcript.
    expect(chat).toContain("cukii-user-bubble--group-middle");
    expect(chat).toContain("cukii-user-bubble--group-start");
    expect(chat).toContain("cukii-user-bubble--group-end");
    expect(chat).toContain("cukii-user-row--group-start");
    expect(chat).toContain("cukii-user-row--group-middle");
    expect(chat).toContain("cukii-user-row--group-end");

    // Agent capsules share the user-capsule geometry (16px corners, MAX
    // insets) and keep shrink-wrapping within the 70% lane; only longread
    // answers may take the full column, never more.
    // Comment-stripped slice: prose comments must never shift the contract
    // window away from the declarations it pins.
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const agentStart = flat.indexOf(".cukii-assistant-bubble {");
    const agentContract = flat.slice(agentStart, agentStart + 330);
    expect(agentContract).toContain("border-radius: 16px;");
    expect(agentContract).toContain("padding: 8px 10px 10px !important;");
    expect(agentContract).toContain("width: fit-content;");
    expect(agentContract).toContain("max-width: 70%;");
    expect(agentContract.replace(/max-width/g, "")).not.toContain(
      "width: 100%",
    );
    expect(css).toContain(".cukii-assistant-bubble--longread {");
  });

  it("mounts the model pill, Milky scope toggle and the two shared slider rows", () => {
    const toolbar = source("components/mainInput/InputToolbar.tsx");
    const modal = source("components/modelSelection/ModelPickerModal.tsx");
    const permissions = source(
      "components/mainInput/PermissionModeControl.tsx",
    );
    const slice = source("redux/slices/sessionSlice.ts");

    // Pill: Claude-style capsule next to the "/" control showing the current
    // broker model, opening the existing picker.
    expect(toolbar).toContain('data-testid="cukii-model-pill"');
    // Measured on the live Claude pill (.modelPill_gGYT1w): 18px tall, 11.05px
    // text, 8px side padding. The earlier 26px/13px/16px capsule was visibly
    // heavier than the reference it claimed parity with.
    expect(toolbar).toContain("h-[18px]");
    expect(toolbar).toContain("rounded-full");
    expect(toolbar).toContain("px-2");
    expect(toolbar).toContain("text-[11.05px]");
    expect(toolbar).toContain("onClick={() => setModelPickerOpen(true)}");
    expect(toolbar).toContain("primaryActionsRef");
    expect(toolbar).toContain("modelPillOnOwnRow");
    expect(toolbar).toContain("shouldPlaceModelPillOnOwnRow");
    expect(toolbar).toContain("cukii-input-footer--model-row");

    // Scope toggle: the single Milky (-0) knob switch pinned to the right
    // edge, symmetric with the "Select a model" title; ON (orange) is the
    // default and shows only Milky-rated models. The choice lives in session
    // state so every picker entry point and reload shares it.
    expect(modal).toContain("cukii-scope-toggle");
    expect(modal).toContain('data-testid="cukii-scope-switch"');
    expect(modal).toContain("cukii-scope-switch-knob");
    expect(modal).toContain('data-testid="cukii-scope-toggle-milky"');
    expect(modal).toContain("Milky");
    expect(modal).toContain("setBrokerModelScope");
    expect(modal).toContain("isBestModel");
    expect(slice).toContain("brokerModelScope: BrokerModelScope;");
    expect(slice).toContain('brokerModelScope: "best",');

    // Live Claude distinction: the current model has only the right-hand
    // check on a transparent row; pointer hover paints that row #04395e via
    // the theme active-selection pair (not the translucent list-hover token).
    const pickerCss = source("index.css");
    expect(pickerCss).toMatch(
      /\.cukii-model-option-selected\s*\{[\s\S]*?background: transparent !important;/,
    );
    expect(pickerCss).toMatch(
      /\.cukii-model-picker-list \.cukii-menu-item:hover:not\(:disabled\)\s*\{[\s\S]*?background: var\(--vscode-list-activeSelectionBackground, #04395e\) !important;[\s\S]*?color: var\(--vscode-list-activeSelectionForeground, #ffffff\) !important;/,
    );
    expect(pickerCss).toMatch(
      /\.cukii-input-footer--model-row \.cukii-footer-secondary-actions\s*\{[\s\S]*?align-self: flex-start;/,
    );
    expect(pickerCss).toMatch(
      /\.cukii-input-footer--model-row \.cukii-model-pill\s*\{[\s\S]*?margin-left: 0;/,
    );

    // Effort: ONE shared slider row component rendered in all three Claude
    // entry points — never a second from-scratch control that can drift.
    const effortRow = source("components/cukii/CukiiEffortRow.tsx");
    expect(effortRow).toContain('testId="cukii-effort-slider"');
    expect(effortRow).toContain("normalizeEffortForModel");
    expect(effortRow).toContain("effortLevelsForModel");
    expect(toolbar).toContain("<CukiiEffortRow");
    expect(modal).toContain("<CukiiEffortRow");
    expect(permissions).toContain("<CukiiEffortRow");
    expect(permissions).toContain("cukii-permission-effort-row");
    expect(pickerCss).toMatch(
      /\.cukii-effort-menu-row \{[\s\S]*?white-space: nowrap;/,
    );

    // Autocompact rides the same slider primitive as Effort — same track, same
    // thumb, same keyboard contract — so the two rows in the "/" menu cannot
    // drift apart. Both delegate to CukiiLevelSlider rather than re-rolling one.
    const autocompactRow = source("components/cukii/CukiiAutocompactRow.tsx");
    const levelSlider = source("components/cukii/CukiiLevelSlider.tsx");
    expect(effortRow).toContain("CukiiLevelSlider");
    expect(autocompactRow).toContain("CukiiLevelSlider");
    expect(autocompactRow).toContain('testId="cukii-autocompact-slider"');
    // Four stops, in the owner's order, with "default" as the right-hand stop.
    expect(
      autocompactRow
        .slice(
          autocompactRow.indexOf("AUTOCOMPACT_LEVELS"),
          autocompactRow.indexOf("AUTOCOMPACT_LABELS"),
        )
        .match(/"(?:25|50|75|default)"/g),
    ).toEqual(['"25"', '"50"', '"75"', '"default"']);
    expect(levelSlider).toContain("data-testid={testId}");
    expect(levelSlider).toContain('role="slider"');
    expect(levelSlider).toContain("aria-valuetext");
    expect(slice).toContain("brokerAutocompact: BrokerAutocompact;");
    expect(slice).toContain('brokerAutocompact: "50",');

    // The "/" menu order is Autocompact above Effort, and both rows share the
    // toggle rows' right edge — the slider track carries no side margin of its
    // own, which is what used to push Effort left of every other control.
    expect(toolbar.indexOf("<CukiiAutocompactRow")).toBeGreaterThanOrEqual(0);
    expect(toolbar.indexOf("<CukiiAutocompactRow")).toBeLessThan(
      toolbar.indexOf("<CukiiEffortRow"),
    );
    const css = source("index.css");
    const sliderStart = css.indexOf(".cukii-effort-slider {");
    expect(sliderStart).toBeGreaterThanOrEqual(0);
    const sliderContract = css.slice(
      sliderStart,
      css.indexOf("\n}", sliderStart),
    );
    expect(sliderContract).toContain("margin: 0;");
    expect(sliderContract).not.toContain("margin: 0 5px;");

    // The slider wears the reference client's own values, resolved through the
    // tokens its `--app-*` aliases point at (`P1HaRA` in claude-parity-spec.md):
    // 76×18 track on the input border, fill on inputOption-activeBorder, 4px
    // notches at 40% of the description foreground, 14px thumb inset 2px, 150ms.
    // Hard-coded hexes here left the control blue-on-grey in every theme.
    const sliderBlock = css.slice(
      sliderStart,
      css.indexOf(".cukii-input-footer", sliderStart),
    );
    expect(sliderBlock).toContain("width: 76px;");
    expect(sliderBlock).toContain("height: 18px;");
    expect(sliderBlock).toContain("border-radius: 9px;");
    expect(sliderBlock).toContain("--vscode-inlineChatInput-border");
    expect(sliderBlock).toContain("--vscode-inputOption-activeBorder");
    expect(sliderBlock).toContain(
      "--vscode-descriptionForeground, #cccccc) 40%",
    );
    expect(sliderBlock).toContain("transition: width 150ms;");
    expect(sliderBlock).toContain("transition: left 150ms;");
    expect(sliderBlock).toContain("box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);");
    // Thumb geometry: 14px inset 2px inside an 18px track.
    expect(sliderBlock).toMatch(
      /\.cukii-effort-thumb \{[\s\S]*?top: 2px;[\s\S]*?width: 14px;[\s\S]*?height: 14px;/,
    );
    // No stray hard-coded control colours left in the block.
    expect(sliderBlock).not.toContain("#007acc;");
    expect(sliderBlock).not.toContain("rgba(204, 204, 204, 0.2)");
    expect(sliderBlock).not.toContain("#b180d7");
    // The top stop recolours the fill, which is what reads at this size.
    expect(css).toContain(".cukii-effort-fill-ultra");
    expect(effortRow).toContain("cukii-effort-fill-ultra");

    // Pill composition: model in the foreground colour, then the dimmed detail
    // run "<Effort> [Fast] [Autocompact unless default]" in that exact order.
    expect(toolbar).toContain('data-testid="cukii-model-pill-detail"');
    expect(toolbar).toContain("text-[var(--vscode-descriptionForeground)]");
    const detailStart = toolbar.indexOf("const pillDetail");
    expect(detailStart).toBeGreaterThanOrEqual(0);
    const detail = toolbar.slice(detailStart, detailStart + 400);
    expect(detail.indexOf("EFFORT_LABELS")).toBeLessThan(
      detail.indexOf('"Fast"'),
    );
    expect(detail.indexOf('"Fast"')).toBeLessThan(
      detail.indexOf("autocompactPillLabel"),
    );
    expect(detail).toMatch(/\.filter\(Boolean\)\s*\.join\(" "\)/);
    // "default" contributes nothing to the pill.
    expect(autocompactRow).toContain(
      'value === AUTOCOMPACT_DEFAULT ? "" : AUTOCOMPACT_LABELS[value]',
    );
  });

  it("dresses the session drawer's filter row in Claude's own tokens", () => {
    // Values read out of the shipped reference bundle
    // (anthropic.claude-code-2.1.260): `.newGroupButton_OOQiHg`,
    // `.filterToggleOn_OOQiHg`, `.activeFilterToggle_OOQiHg`,
    // `.statusFilterMenuButton_OOQiHg`, `.statusFilterCaret_OOQiHg`, with each
    // of its `--app-*` aliases resolved to the `--vscode-*` token it maps to.
    const navigator = source("pages/sessions/CukiiSessionNavigator.tsx");

    // Shared chip geometry.
    expect(navigator).toContain("gap: 4px;");
    expect(navigator).toContain("margin-left: 4px;");
    expect(navigator).toContain("padding: 4px 8px;");
    expect(navigator).toContain("font-size: 0.9em;");
    expect(navigator).toContain("color: var(--vscode-descriptionForeground);");
    expect(navigator).toContain(
      "background: var(--vscode-toolbar-hoverBackground);",
    );

    // "On" state uses the list-active pair, and only here.
    expect(navigator).toContain(
      "background: var(--vscode-list-activeSelectionBackground);",
    );
    expect(navigator).toContain(
      "color: var(--vscode-list-activeSelectionForeground);",
    );
    expect(navigator).toContain(
      "outline: 1px solid var(--vscode-list-activeSelectionForeground);",
    );
    expect(navigator).toContain("outline-offset: -1px;");

    // The count must not jitter, the caret is 14px and the icons are 16px.
    expect(navigator).toContain('fontVariantNumeric: "tabular-nums"');
    expect(navigator).toContain("{ gap: 2, paddingRight: 6 }");
    expect(navigator).toContain("{ width: 16, height: 16, flexShrink: 0 }");
    expect(navigator).toContain("{ width: 14, height: 14, flexShrink: 0 }");

    // Labels: "Active · N" on the chip, "<name> · N" on every menu entry.
    expect(navigator).toContain("`Active · ${filterCounts.active}`");
    expect(navigator).toContain(
      "`${SESSION_STATUS_LABELS[status]} · ${filterCounts.byStatus[status]}`",
    );
    expect(navigator).toContain(
      "`${SESSION_TAB_STATE_LABELS[tabState]} · ${filterCounts.byTabState[tabState]}`",
    );

    // Menus wear the menu tokens, never the list ones — one shell for the
    // status filter, session and group menus, as in the reference client.
    expect(navigator).toContain(
      "background: var(--vscode-menu-selectionBackground);",
    );
    expect(navigator).toContain(
      "color: var(--vscode-menu-selectionForeground);",
    );
    const menuItem = navigator.slice(
      navigator.indexOf("const MenuItem = styled.button`"),
      navigator.indexOf("const MenuSeparator"),
    );
    expect(menuItem).not.toContain("--vscode-list-hoverBackground");
    expect(navigator).toContain("border-radius: 6px;");
    expect(navigator).toContain("padding: 6px 12px;");
    expect(navigator).toContain("padding: 4px 12px;");
    expect(navigator).toContain("box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);");
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

  it("uses shared command sections, Claude list-active selection tokens, and no fake Rewind", () => {
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
    expect(selectionRule).toContain("--vscode-list-activeSelectionBackground");
    expect(selectionRule).toContain("--vscode-list-activeSelectionForeground");
    expect(selectionRule).not.toContain("--vscode-list-hoverBackground");
    expect(selectionRule).not.toContain("--vscode-menu-selectionBackground");
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

    // The assistant wears the slate capsule with the same MAX geometry the
    // user capsule uses (16px corners), only left-aligned and slate-filled.
    const botStart = css.indexOf(".cukii-assistant-bubble {");
    expect(botStart).toBeGreaterThanOrEqual(0);
    // The whole rule, not a fixed slice: a comment inside it must not decide
    // whether a declaration is considered present.
    const botContract = css.slice(botStart, css.indexOf("}", botStart) + 1);
    expect(botContract).toContain("--vscode-input-background");
    expect(botContract).toContain("border-radius: 16px;");
    expect(botContract).toContain("width: fit-content;");
    // Without this the longread variant's `width: 100%` measures the content
    // box and the capsule hangs its padding and border past the row, eating
    // the transcript's right gutter and adding a horizontal scrollbar.
    expect(botContract).toContain("box-sizing: border-box;");

    // The capsule's own 8/10/10 inset is the entire gutter: markdown's leading
    // and trailing block margins collapse into it otherwise, and the answer
    // sits lower in its capsule than the user's prose does in theirs.
    expect(css).toMatch(
      /\.cukii-assistant-bubble > \* > :first-child \{\s*margin-top: 0 !important;/,
    );
    expect(css).toMatch(
      /\.cukii-assistant-bubble > \* > :last-child \{\s*margin-bottom: 0 !important;/,
    );
    // Paragraph rhythm measured in the shipped Claude Code webview 2.1.261.
    expect(css).toMatch(
      /\.cukii-assistant-bubble p \{\s*margin: 1\.3px 0 2\.6px;/,
    );

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

    // MAX centres its 16px indicator slot on the 14px time line and uses the
    // exact filled 24-unit glyph from its live SVG sprite.
    expect(css).toMatch(/\.cukii-user-metadata \{[\s\S]*?align-items: center;/);
    expect(css).toMatch(
      /\.cukii-user-metadata \{[\s\S]*?letter-spacing: 0\.3px;/,
    );
    expect(css).toMatch(
      /\.cukii-receipt-status \{[\s\S]*?width: 16px;[\s\S]*?height: 16px;[\s\S]*?align-self: center;/,
    );
    const receipt = source("components/cukii/CukiiMessageReceiptStatus.tsx");
    expect(receipt).toContain('viewBox="0 0 24 24"');
    expect(receipt).toContain("M18.089 5.589");
    expect(receipt).toContain("m5.459-.001");

    // Right-click uses the native webview context menu: the extension
    // contributes session commands through webview/context, and the GUI keeps
    // no custom overlay.
    const manifest = readFileSync(
      join(process.cwd(), "..", "extensions", "vscode", "package.json"),
      "utf8",
    );
    expect(manifest).toContain('"webview/context"');
    expect(manifest).toContain("webviewId == 'cukii.fullScreenChat'");
    expect(chat).not.toContain("CukiiMessageContextMenu");
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
    const sentContract =
      flatSent.match(/^\.cukii-user-message-bubble \{[^}]*\}/m)?.[0] ?? "";
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
    // Claude metrics: content-sized rows (no fixed min-height), and the
    // selected mode wears the theme's active-selection tokens, not a
    // hardcoded blue.
    expect(panelContract).not.toContain("min-height: 52px;");
    expect(panelContract).toContain("background: transparent !important;");
    expect(panelContract).toContain(
      "background: var(--vscode-list-activeSelectionBackground, #04395e) !important;",
    );
    expect(panelContract).toContain(
      "color: var(--vscode-list-activeSelectionForeground, #ffffff) !important;",
    );
    expect(panelContract).toContain('html[data-cukii-panel-tone="light"]');
    expect(panelContract).toContain("#ffffff) !important;");
    expect(panelContract).toContain(".cukii-permission-mode-row:focus-visible");
  });
});
