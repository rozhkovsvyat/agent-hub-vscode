import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

type Keybinding = {
  command: string;
  key?: string;
  mac?: string;
  when?: string;
};
type Manifest = {
  contributes: {
    keybindings: Keybinding[];
    commands: { command: string }[];
    menus: Record<
      string,
      { command?: string; submenu?: string; when?: string }[]
    >;
    submenus: { id: string; label: string }[];
  };
};

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
) as Manifest;

// Inherited Continue features a Cukii Chat user cannot use: they need models
// configured in Continue's own config, while chat runs on the vendor CLIs.
const DEAD_FEATURE_COMMANDS = [
  "continue.toggleTabAutocompleteEnabled",
  "continue.forceAutocomplete",
  "continue.toggleNextEditEnabled",
  "continue.forceNextEdit",
  "continue.acceptJump",
  "continue.rejectJump",
  "continue.writeCommentsForCode",
  "continue.writeDocstringForCode",
  "continue.fixCode",
  "continue.optimizeCode",
  "continue.fixGrammar",
  "continue.codebaseForceReIndex",
  "continue.rebuildCodebaseIndex",
  "continue.docsIndex",
  "continue.docsReIndex",
  "continue.enterEnterpriseLicenseKey",
  "continue.focusEdit",
  "continue.applyCodeFromChat",
  "continue.openConfigPage",
];

describe("Cukii Chat shortcuts and palette (2026-10-02)", () => {
  it("does not steal everyday editor shortcuts", () => {
    // Up to 2.0.160: ⌥A (types "å" on macOS) applied code, ⌘I opened
    // Continue's Edit mode over VS Code's inline chat, ⌘⇧R and ⌥⌘Y/⌥⌘N were
    // bound everywhere, ⌘K ⌘A / ⌘K ⌘N / ⌘⌥Space drove dead features.
    const always = manifest.contributes.keybindings.filter((k) => !k.when);
    const alwaysKeys = always.map((k) => k.mac ?? k.key);
    for (const stolen of [
      "alt+a",
      "cmd+i",
      "cmd+shift+r",
      "alt+cmd+y",
      "alt+cmd+n",
    ]) {
      expect(alwaysKeys).not.toContain(stolen);
    }
    for (const k of manifest.contributes.keybindings) {
      expect(DEAD_FEATURE_COMMANDS).not.toContain(k.command);
    }
    const diffBlockKeys = manifest.contributes.keybindings.filter((k) =>
      /VerticalDiffBlock$/.test(k.command),
    );
    expect(diffBlockKeys.length).toBeGreaterThan(0);
    for (const k of diffBlockKeys) expect(k.when).toBe("continue.diffVisible");
  });

  it("keeps the chat focus shortcut", () => {
    const focus = manifest.contributes.keybindings.find(
      (k) => k.command === "continue.focusCuKiiInput",
    );
    expect(focus?.mac).toBe("cmd+l");
  });

  it("hides dead features from the command palette", () => {
    const palette = manifest.contributes.menus.commandPalette;
    for (const command of DEAD_FEATURE_COMMANDS) {
      const entry = palette.find((item) => item.command === command);
      expect(entry, command).toBeDefined();
      expect(entry?.when, command).toBe("false");
    }
  });

  it("names the editor submenu Cukii Chat and drops the dead Edit item", () => {
    const submenu = manifest.contributes.submenus.find(
      (item) => item.id === "continue.continueSubMenu",
    );
    expect(submenu?.label).toBe("Cukii Chat");
    const items = manifest.contributes.menus["continue.continueSubMenu"].map(
      (item) => item.command,
    );
    expect(items).not.toContain("continue.focusEdit");
  });

  it("advertises only chat in the inline editor tip", () => {
    const tip = readFileSync(
      join(__dirname, "activation", "InlineTipManager.ts"),
      "utf8",
    );
    expect(tip).toContain('chatLabel: "Cukii Chat"');
    expect(tip).not.toContain("SVG_CONFIG.editLabel,");
  });
});
