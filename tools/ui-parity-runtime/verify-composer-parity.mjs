import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const measure = (extraEnv = {}) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("./measure-composer-parity.mjs", import.meta.url),
        ),
      ],
      { encoding: "utf8", env: { ...process.env, ...extraEnv } },
    ),
  );

const measurement = measure();

const claude = measurement["Anthropic.claude-code"];
const cukii = measurement["cukii.cukii-vscode"];
const checks = {};
const close = (left, right, tolerance = 0.1) =>
  Math.abs(left - right) <= tolerance;
const px = (value) => Number.parseFloat(value);

checks.composerFill =
  claude.contract.composer.background === cukii.contract.composer.background;
checks.composerBorder =
  claude.contract.composer.border === cukii.contract.composer.border;
checks.composerTypography = [
  "color",
  "fontFamily",
  "fontSize",
  "lineHeight",
  "borderRadius",
].every(
  (key) => claude.contract.composer[key] === cukii.contract.composer[key],
);
checks.inputTypography = ["fontFamily", "fontSize", "lineHeight"].every(
  (key) => claude.contract.input[key] === cukii.contract.input[key],
);
checks.placeholderTypographyAndColor = [
  "color",
  "fontFamily",
  "fontSize",
  "lineHeight",
].every(
  (key) => claude.contract.placeholder[key] === cukii.contract.placeholder[key],
);
checks.voiceGeometryAndColor =
  ["width", "height"].every((key) =>
    close(claude.contract.voice.rect[key], cukii.contract.voice.rect[key]),
  ) &&
  ["color", "fontFamily", "fontSize", "borderRadius"].every(
    (key) => claude.contract.voice[key] === cukii.contract.voice[key],
  );

const claudeInset =
  claude.contract.input.rect.x +
  px(claude.contract.input.paddingLeft) -
  claude.contract.composer.rect.x;
const cukiiInset = cukii.contract.input.rect.x - cukii.contract.composer.rect.x;
checks.windowsLeftInputInset = close(claudeInset, cukiiInset);

const relativeRect = (rect, composer) => ({
  x: rect.x - composer.x,
  y: rect.y - composer.y,
  right: composer.right - rect.right,
  bottom: composer.bottom - rect.bottom,
  width: rect.width,
  height: rect.height,
});
const claudeAdd = relativeRect(
  claude.controls.add.rect,
  claude.contract.composer.rect,
);
const cukiiAdd = relativeRect(
  cukii.controls.add.rect,
  cukii.contract.composer.rect,
);
const claudeMenu = relativeRect(
  claude.controls.menu.rect,
  claude.contract.composer.rect,
);
const cukiiMenu = relativeRect(
  cukii.controls.menu.rect,
  cukii.contract.composer.rect,
);
checks.footerControlAlignment =
  ["x", "y", "bottom", "width", "height"].every((key) =>
    close(claudeAdd[key], cukiiAdd[key], 0.75),
  ) &&
  ["x", "y", "bottom", "width", "height"].every((key) =>
    close(claudeMenu[key], cukiiMenu[key], 0.75),
  );
checks.footerTypography = ["fontFamily", "fontSize", "lineHeight"].every(
  (key) => claude.contract.footer[key] === cukii.contract.footer[key],
);
checks.footerColor =
  claude.contract.footer.color === cukii.contract.footer.color;
checks.footerControlColors = ["add", "menu"].every((control) =>
  ["color", "background", "border", "borderRadius"].every(
    (key) =>
      claude.controls[control].style[key] ===
      cukii.controls[control].style[key],
  ),
);

const claudePermission = claude.controls.permission;
const cukiiPermission = cukii.controls.permission;
const labelVisible = (control) =>
  Boolean(control?.label) &&
  control.label.display !== "none" &&
  control.label.rect.width > 0;
const claudePermissionLabelVisible = labelVisible(claudePermission);
const cukiiPermissionLabelVisible = labelVisible(cukiiPermission);
checks.permissionResponsiveState =
  Boolean(claudePermission && cukiiPermission) &&
  claudePermissionLabelVisible === cukiiPermissionLabelVisible &&
  (claudePermissionLabelVisible ||
    ["width", "height"].every((key) =>
      close(claudePermission.rect[key], cukiiPermission.rect[key], 0.75),
    ));

const claudeVisibleCap =
  px(claude.contract.wrapper.maxWidth) +
  2 * px(claude.contract.composer.border);
const cukiiVisibleCap =
  px(cukii.contract.wrapper.maxWidth) -
  px(cukii.contract.wrapper.paddingLeft) -
  px(cukii.contract.wrapper.padding.split(" ")[1]);
checks.maximumComposerWidth = close(claudeVisibleCap, cukiiVisibleCap, 1);

const pass = Object.values(checks).every(Boolean);
const receipt = {
  endpoint: process.env.CUKII_CDP_ENDPOINT ?? "http://127.0.0.1:9222",
  pass,
  checks,
  evidence: {
    composer: {
      claude: claude.contract.composer,
      cukii: cukii.contract.composer,
    },
    footer: {
      claude: claude.contract.footer,
      cukii: cukii.contract.footer,
    },
    placeholder: {
      claude: claude.contract.placeholder,
      cukii: cukii.contract.placeholder,
    },
    voice: {
      claude: claude.contract.voice,
      cukii: cukii.contract.voice,
    },
    leftInputInset: { claude: claudeInset, cukii: cukiiInset },
    controls: { claudeAdd, cukiiAdd, claudeMenu, cukiiMenu },
    permission: {
      claude: claudePermission,
      cukii: cukiiPermission,
      labelVisible: {
        claude: claudePermissionLabelVisible,
        cukii: cukiiPermissionLabelVisible,
      },
    },
    maximumVisibleWidth: { claude: claudeVisibleCap, cukii: cukiiVisibleCap },
  },
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (!pass) process.exitCode = 2;
