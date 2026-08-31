import type { BrokerModel } from "./protocol/ideWebview";
import type { BrokerVendorId } from "./cukiiVendorRegistry";

/** Canonical Cukii permission modes (Claude-parity ids). */
export type CukiiPermissionMode =
  | "manual"
  | "editAutomatically"
  | "plan"
  | "auto"
  | "bypass";

export const CUKII_PERMISSION_MODE_ORDER: readonly CukiiPermissionMode[] = [
  "manual",
  "editAutomatically",
  "plan",
  "auto",
  "bypass",
] as const;

export const CUKII_PERMISSION_MODE_COPY: Record<
  CukiiPermissionMode,
  { title: string; description: string }
> = {
  manual: {
    title: "Manual",
    description: "Cukii will ask for approval before making each edit",
  },
  editAutomatically: {
    title: "Edit automatically",
    description: "Cukii will edit your selected text or the whole file",
  },
  plan: {
    title: "Plan",
    description:
      "Cukii will explore the code and present a plan before editing",
  },
  auto: {
    title: "Auto",
    description:
      "Cukii will approve actions that pass a safety check and pause for anything risky",
  },
  bypass: {
    title: "Bypass permissions",
    description:
      "Cukii will not ask for approval before running potentially dangerous commands",
  },
};

export type VendorPermissionCapabilities = {
  vendor: BrokerVendorId;
  supportedModes: CukiiPermissionMode[];
  /** A noninteractive CLI transport with an intrinsic, non-flag permission policy. */
  nonInteractiveRoute?: "prompt-mode";
  cliVersion?: string;
  helpSource: string;
};

/** Captured help samples used only by parser unit tests, never as runtime fallback. */
export const VENDOR_CLI_HELP_FIXTURES: Record<BrokerVendorId, string> = {
  claude: [
    '--permission-mode <mode> Permission mode (choices: "acceptEdits", "auto",',
    '"bypassPermissions", "manual", "dontAsk", "plan")',
    "--dangerously-skip-permissions Bypass all permission checks.",
  ].join("\n"),
  codex: [
    "-s, --sandbox <SANDBOX_MODE>",
    "[possible values: read-only, workspace-write, danger-full-access]",
    "--approve-for-me Route approval requests through automatic review",
    "--dangerously-bypass-approvals-and-sandbox Skip all confirmation prompts",
  ].join("\n"),
  grok: [
    "--permission-mode <MODE>",
    "[possible values: default, acceptEdits, auto, dontAsk, bypassPermissions, plan]",
    "--always-approve Auto-approve all tool executions",
  ].join("\n"),
  cursor: [
    '--mode <mode> (choices: "plan", "ask")',
    "--plan Start in plan mode",
    "--auto-review Use Auto-review (Smart Auto)",
    "--force Force allow commands unless explicitly denied",
    "--yolo Alias for --force",
    "--trust Trust the current workspace without prompting",
  ].join("\n"),
  kimi: [
    "-p, --prompt <prompt> Run one prompt non-interactively and print the response.",
    "--output-format <format> Output format for prompt mode.",
    "-y, --yolo Auto-approve regular tool calls",
    "--auto Start in auto permission mode: fully autonomous",
    "--plan Start in plan mode",
  ].join("\n"),
  qwen: [
    'Argument: approval-mode, Choices: "plan", "default", "auto-edit", "auto", "yolo"',
  ].join("\n"),
  deepseek: "",
};

const CLAUDE_MODELS = new Set(["opus-5", "sonnet-5", "fable-5", "haiku-4-5"]);

export function brokerVendorForModel(model: BrokerModel): BrokerVendorId {
  if (CLAUDE_MODELS.has(model)) return "claude";
  if (model.startsWith("codex:") || model.startsWith("codex-")) return "codex";
  if (
    model === "grok-4-6" ||
    model === "grok-4-5" ||
    model.startsWith("grok:")
  ) {
    return "grok";
  }
  if (model === "composer-2-5" || model.startsWith("cursor:")) return "cursor";
  if (model.startsWith("kimi:") || model.startsWith("kimi-")) return "kimi";
  if (model === "deepseek-v4-pro") return "deepseek";
  if (model === "qwen-3-8-max" || model.startsWith("qwen:")) return "qwen";
  return "claude";
}

function helpIncludes(help: string, fragment: string): boolean {
  return help.toLowerCase().includes(fragment.toLowerCase());
}

/** Parse supported Cukii modes from native CLI --help (and optional version). */
export function parseVendorPermissionCapabilities(
  vendor: BrokerVendorId,
  helpText: string,
  cliVersion?: string,
  _claudePermissionPromptToolReady = false,
): VendorPermissionCapabilities {
  const supported = new Set<CukiiPermissionMode>();
  const help = helpText.trim();

  switch (vendor) {
    case "claude": {
      // Claude Code 2.1.251 accepts all five Cukii mode mappings.  Capability
      // discovery must describe the native CLI, not hide valid rows because a
      // separate prompt transport has not been instantiated yet.
      if (helpIncludes(help, "permission-mode") && helpIncludes(help, "plan")) {
        supported.add("plan");
        supported.add("manual");
        supported.add("editAutomatically");
        supported.add("auto");
      }
      if (helpIncludes(help, "dangerously-skip-permissions")) {
        supported.add("bypass");
      }
      break;
    }
    case "codex": {
      if (helpIncludes(help, "dangerously-bypass-approvals-and-sandbox")) {
        supported.add("bypass");
      }
      break;
    }
    case "grok": {
      if (helpIncludes(help, "permission-mode") && helpIncludes(help, "plan")) {
        supported.add("plan");
      }
      if (
        helpIncludes(help, "permission-mode") &&
        helpIncludes(help, "bypassPermissions")
      ) {
        supported.add("bypass");
      }
      break;
    }
    case "cursor": {
      if (helpIncludes(help, "--plan") || helpIncludes(help, "--mode <mode>")) {
        supported.add("plan");
      }
      if (helpIncludes(help, "--force") || helpIncludes(help, "--yolo")) {
        supported.add("bypass");
      }
      break;
    }
    case "kimi": {
      // Kimi documents that -p rejects --auto/-y/--plan because prompt-mode
      // already runs noninteractively under its intrinsic auto policy. Its
      // only verified headless route is therefore prompt-mode, not a flag.
      if (helpIncludes(help, "--prompt")) supported.add("bypass");
      break;
    }
    case "qwen": {
      if (helpIncludes(help, '"plan"')) supported.add("plan");
      if (helpIncludes(help, "yolo")) supported.add("bypass");
      break;
    }
    case "deepseek":
      break;
  }

  const supportedModes = CUKII_PERMISSION_MODE_ORDER.filter((mode) =>
    supported.has(mode),
  );

  return {
    vendor,
    supportedModes,
    ...(vendor === "kimi" && helpIncludes(help, "--prompt")
      ? { nonInteractiveRoute: "prompt-mode" as const }
      : {}),
    cliVersion,
    helpSource: help.slice(0, 240),
  };
}

export function defaultVendorPermissionCapabilities(
  vendor: BrokerVendorId,
): VendorPermissionCapabilities {
  return parseVendorPermissionCapabilities(
    vendor,
    VENDOR_CLI_HELP_FIXTURES[vendor] ?? "",
  );
}

export function safestSupportedPermissionMode(
  capabilities: VendorPermissionCapabilities,
): CukiiPermissionMode {
  // Never turn an unsupported saved Manual/Auto mode into Bypass merely
  // because Bypass is the only capability discovered for a different model.
  // Keeping Manual causes the bridge to fail closed until the user selects a
  // verified visible mode.
  if (capabilities.supportedModes.includes("plan")) return "plan";
  return "manual";
}

export function resolvePermissionModeForVendor(
  capabilities: VendorPermissionCapabilities,
  requested: CukiiPermissionMode | undefined,
): CukiiPermissionMode {
  const fallback = safestSupportedPermissionMode(capabilities);
  if (!requested) return fallback;
  return capabilities.supportedModes.includes(requested) ? requested : fallback;
}

export function visiblePermissionModes(
  capabilities: VendorPermissionCapabilities,
): CukiiPermissionMode[] {
  return CUKII_PERMISSION_MODE_ORDER.filter((mode) =>
    capabilities.supportedModes.includes(mode),
  );
}

export function cyclePermissionMode(
  current: CukiiPermissionMode,
  visible: readonly CukiiPermissionMode[],
): CukiiPermissionMode {
  if (visible.length === 0) return current;
  const index = visible.indexOf(current);
  const nextIndex = index < 0 ? 0 : (index + 1) % visible.length;
  return visible[nextIndex];
}

export function coerceStoredPermissionMode(
  value: unknown,
  legacyAllowAllPermissions = false,
): CukiiPermissionMode {
  if (
    value === "manual" ||
    value === "editAutomatically" ||
    value === "plan" ||
    value === "auto" ||
    value === "bypass"
  ) {
    return value;
  }
  if (legacyAllowAllPermissions) return "bypass";
  return "manual";
}

export type PermissionArgvSpec = {
  args: string[];
  forbidden: string[];
};

export function permissionArgvForVendor(
  vendor: BrokerVendorId,
  mode: CukiiPermissionMode,
): PermissionArgvSpec {
  switch (vendor) {
    case "claude":
      return claudePermissionArgv(mode);
    case "codex":
      return codexPermissionArgv(mode);
    case "grok":
      return grokPermissionArgv(mode);
    case "cursor":
      return cursorPermissionArgv(mode);
    case "kimi":
      return kimiPermissionArgv(mode);
    case "qwen":
      return qwenPermissionArgv(mode);
    default:
      return { args: [], forbidden: [] };
  }
}

function claudePermissionArgv(mode: CukiiPermissionMode): PermissionArgvSpec {
  switch (mode) {
    case "manual":
      return {
        args: ["--permission-mode", "manual"],
        forbidden: ["--dangerously-skip-permissions"],
      };
    case "editAutomatically":
      return {
        args: ["--permission-mode", "acceptEdits"],
        forbidden: ["--dangerously-skip-permissions"],
      };
    case "plan":
      return {
        args: ["--permission-mode", "plan"],
        forbidden: ["--dangerously-skip-permissions"],
      };
    case "auto":
      return {
        args: ["--permission-mode", "auto"],
        forbidden: ["--dangerously-skip-permissions"],
      };
    case "bypass":
      return {
        args: ["--dangerously-skip-permissions"],
        forbidden: ["--permission-mode"],
      };
  }
}

function codexPermissionArgv(mode: CukiiPermissionMode): PermissionArgvSpec {
  switch (mode) {
    case "bypass":
      return {
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        forbidden: ["--approve-for-me"],
      };
    default:
      return { args: [], forbidden: [] };
  }
}

function grokPermissionArgv(mode: CukiiPermissionMode): PermissionArgvSpec {
  const nativeMode = {
    manual: "default",
    editAutomatically: "acceptEdits",
    plan: "plan",
    auto: "auto",
    bypass: "bypassPermissions",
  }[mode];
  return {
    args: ["--permission-mode", nativeMode],
    forbidden: ["--always-approve"],
  };
}

function cursorPermissionArgv(mode: CukiiPermissionMode): PermissionArgvSpec {
  switch (mode) {
    case "plan":
      return {
        args: ["--plan"],
        forbidden: ["--force", "--yolo", "--auto-review", "--trust"],
      };
    case "bypass":
      return {
        args: ["--force"],
        forbidden: ["--auto-review", "--plan", "--mode", "--yolo", "--trust"],
      };
    default:
      return { args: [], forbidden: ["--trust", "--force", "--plan"] };
  }
}

function kimiPermissionArgv(_mode: CukiiPermissionMode): PermissionArgvSpec {
  // Kimi rejects --auto, -y and --plan with -p: prompt-mode has documented
  // implicit auto permission for regular tools and still enforces static deny
  // rules. No redundant or incompatible permission flag is permitted here.
  return { args: [], forbidden: ["--yolo", "-y", "--auto", "--plan"] };
}

function qwenPermissionArgv(mode: CukiiPermissionMode): PermissionArgvSpec {
  if (mode === "plan") {
    return { args: ["--approval-mode", "plan"], forbidden: ["yolo"] };
  }
  if (mode === "bypass") {
    return { args: ["--approval-mode", "yolo"], forbidden: ["plan"] };
  }
  return { args: [], forbidden: ["--approval-mode"] };
}

export function permissionArgvForModel(
  model: BrokerModel,
  mode: CukiiPermissionMode,
): PermissionArgvSpec {
  return permissionArgvForVendor(brokerVendorForModel(model), mode);
}
