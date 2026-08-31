import type {
  BrokerEffort,
  BrokerModel,
  BrokerSpeed,
  CukiiPermissionMode,
} from "core/protocol/ideWebview";
import {
  brokerVendorForModel,
  defaultVendorPermissionCapabilities,
  permissionArgvForVendor,
  resolvePermissionModeForVendor,
} from "core/cukiiPermissionModes";
import { cachedVendorPermissionCapabilities } from "./permissionCapabilities";

export type BridgeControlResolution = {
  requestedEffort: BrokerEffort;
  nativeEffort?: Exclude<BrokerEffort, "ultra">;
  effortTransport: "native" | "native-clamped" | "broker-contract";
  requestedSpeed: BrokerSpeed;
  effectiveSpeed: BrokerSpeed;
  speedTransport: "native" | "unavailable";
  requestedThinking: boolean;
  effectiveThinking: boolean;
  thinkingTransport: "native" | "unavailable";
};

function isCodexModel(model: BrokerModel): boolean {
  return model.startsWith("codex-") || model.startsWith("codex:");
}

function supportsNativeSpeed(model: BrokerModel): boolean {
  return (
    model === "opus-5" ||
    isCodexModel(model) ||
    model === "composer-2-5" ||
    model.startsWith("cursor:")
  );
}

function supportsNativeThinking(model: BrokerModel): boolean {
  return (
    model === "opus-5" ||
    model === "sonnet-5" ||
    isCodexModel(model) ||
    model.startsWith("cursor:claude-")
  );
}

function nativeEffortFor(
  model: BrokerModel,
  effort: BrokerEffort,
  thinkingEnabled: boolean,
): BridgeControlResolution["nativeEffort"] {
  // Opus 5 принимает disabled thinking только с effort <= high. Выбранный
  // пользователем уровень сохраняется в сессии, но нативный argv должен быть
  // валидным, пока Thinking выключен.
  if (
    model === "opus-5" &&
    !thinkingEnabled &&
    (effort === "xhigh" || effort === "max" || effort === "ultra")
  ) {
    return "high";
  }
  if (
    model === "opus-5" ||
    model === "sonnet-5" ||
    model === "fable-5" ||
    model === "haiku-4-5" ||
    isCodexModel(model) ||
    model.startsWith("cursor:")
  ) {
    return effort === "ultra" ? "max" : effort;
  }
  if (
    model === "grok-4-6" ||
    model === "grok-4-5" ||
    model.startsWith("grok:")
  ) {
    if (effort === "ultra" || effort === "max") return "xhigh";
    return effort;
  }
  return undefined;
}

export function resolveBridgeControls(
  model: BrokerModel,
  effort: BrokerEffort,
  speed: BrokerSpeed,
  thinkingEnabled = true,
): BridgeControlResolution {
  const nativeThinking = supportsNativeThinking(model);
  const effectiveThinking = nativeThinking ? thinkingEnabled : true;
  const nativeEffort = nativeEffortFor(model, effort, effectiveThinking);
  const nativeSpeed = supportsNativeSpeed(model);
  return {
    requestedEffort: effort,
    nativeEffort,
    effortTransport: nativeEffort
      ? nativeEffort === effort
        ? "native"
        : "native-clamped"
      : "broker-contract",
    requestedSpeed: speed,
    effectiveSpeed: speed === "fast" && !nativeSpeed ? "standard" : speed,
    speedTransport: nativeSpeed ? "native" : "unavailable",
    requestedThinking: thinkingEnabled,
    effectiveThinking,
    thinkingTransport: nativeThinking ? "native" : "unavailable",
  };
}

export function bridgeControlPrompt(
  controls: BridgeControlResolution,
): string[] {
  const effortInstruction =
    controls.requestedEffort === "low"
      ? "Prefer a direct solution and avoid optional exploration or delegation."
      : controls.requestedEffort === "medium"
        ? "Use a balanced amount of investigation and verification."
        : controls.requestedEffort === "high"
          ? "Investigate carefully and verify the important paths before concluding."
          : controls.requestedEffort === "xhigh"
            ? "Use deep reasoning, negative checks, and thorough verification."
            : controls.requestedEffort === "max"
              ? "Use the maximum useful reasoning and adversarial verification for this task."
              : "Use maximum reasoning plus explicit decomposition, delegation when useful, and adversarial acceptance.";
  return [
    controls.thinkingTransport === "native" && !controls.effectiveThinking
      ? `Cukii effort: ${controls.requestedEffort} is saved but inactive while Thinking is off.`
      : `Cukii effort: ${controls.requestedEffort} (${controls.effortTransport}${controls.nativeEffort ? `:${controls.nativeEffort}` : ""}). ${effortInstruction}`,
    controls.speedTransport === "native"
      ? `Cukii speed: ${controls.effectiveSpeed} (native vendor service tier).`
      : `Cukii speed: standard. This vendor exposes no native accelerated tier; do not claim Fast is active.`,
    controls.thinkingTransport === "native"
      ? `Cukii thinking: ${controls.effectiveThinking ? "on" : "off"} (native vendor control).`
      : "Cukii thinking: on. This vendor exposes no verified native on/off control.",
  ];
}

export function bridgeControlSummary(
  controls: BridgeControlResolution,
): string {
  const effort =
    controls.thinkingTransport === "native" && !controls.effectiveThinking
      ? `${controls.requestedEffort} (saved; inactive while Thinking is off)`
      : controls.nativeEffort
        ? `${controls.requestedEffort} (${controls.effortTransport}: ${controls.nativeEffort})`
        : `${controls.requestedEffort} (broker contract)`;
  const speed =
    controls.speedTransport === "native"
      ? `${controls.effectiveSpeed} (native)`
      : "standard (Fast unavailable for this vendor)";
  const thinking =
    controls.thinkingTransport === "native"
      ? `${controls.effectiveThinking ? "on" : "off"} (native)`
      : "on (toggle unavailable for this vendor)";
  return `Effort: ${effort}. Speed: ${speed}. Thinking: ${thinking}.`;
}

export function claudeControlArgs(controls: BridgeControlResolution): string[] {
  const settings: {
    fastMode: boolean;
    alwaysThinkingEnabled?: boolean;
  } = {
    fastMode: controls.effectiveSpeed === "fast",
  };
  if (controls.thinkingTransport === "native") {
    settings.alwaysThinkingEnabled = controls.effectiveThinking;
  }
  return [
    "--effort",
    controls.nativeEffort ?? "high",
    "--settings",
    JSON.stringify(settings),
  ];
}

export function codexControlArgs(controls: BridgeControlResolution): string[] {
  return [
    "-c",
    `model_reasoning_effort="${controls.effectiveThinking ? (controls.nativeEffort ?? "high") : "none"}"`,
    "-c",
    `service_tier="${controls.effectiveSpeed === "fast" ? "priority" : "default"}"`,
  ];
}

export function grokControlArgs(controls: BridgeControlResolution): string[] {
  return ["--reasoning-effort", controls.nativeEffort ?? "high"];
}

export function cursorModelId(controls: BridgeControlResolution): string {
  return controls.effectiveSpeed === "fast"
    ? "composer-2.5-fast"
    : "composer-2.5";
}

export function permissionControlArgs(
  model: BrokerModel,
  mode: CukiiPermissionMode,
): string[] {
  const vendor = brokerVendorForModel(model);
  // Claude's non-bypass modes are made real by the per-run MCP broker in
  // bridgeChatAdapter. Discovery remains responsible for UI visibility, but a
  // restored session must not race its asynchronous capability probe.
  if (vendor === "claude") {
    return permissionArgvForVendor(vendor, mode).args;
  }
  if (vendor === "kimi") {
    // Kimi 0.38 documents --auto and --plan in its native --help. The picker
    // and first routed K3 turn can race asynchronous discovery, so its captured
    // help contract is the bounded cold-start capability set.
    const capabilities =
      cachedVendorPermissionCapabilities("kimi") ??
      defaultVendorPermissionCapabilities("kimi");
    if (capabilities.nonInteractiveRoute === "prompt-mode") {
      // The existing default Bypass selector enters Kimi's sole verified
      // headless route, but must not translate into --auto/-y/--plan: 0.38
      // rejects every one of those flags with -p. Kimi documents this as its
      // intrinsic prompt-mode auto policy for regular tools (static deny rules
      // remain), so Bypass is the compatible Cukii selector rather than argv.
      if (mode !== "bypass") {
        throw new Error(
          "kimi has no verified permission mode for this noninteractive bridge route.",
        );
      }
      return [];
    }
    // Do not silently turn a user-selected unsupported mode into --auto. The
    // route default is already Bypass, while every explicit unsupported choice
    // fails closed before native process creation.
    if (!capabilities.supportedModes.includes(mode)) {
      throw new Error(
        "kimi has no verified permission mode for this noninteractive bridge route.",
      );
    }
    return permissionArgvForVendor("kimi", mode).args;
  }
  if (vendor === "qwen") {
    // Qwen's noninteractive bridge route is synchronously assembled as
    // `--safe-mode --prompt ... --approval-mode <mode>`. Its captured native
    // approval-mode contract keeps the first routed turn from racing the
    // asynchronous capability probe, while a completed probe still wins.
    const capabilities =
      cachedVendorPermissionCapabilities("qwen") ??
      defaultVendorPermissionCapabilities("qwen");
    if (!capabilities.supportedModes.includes(mode)) {
      throw new Error(
        "qwen has no verified permission mode for this noninteractive bridge route.",
      );
    }
    return permissionArgvForVendor("qwen", mode).args;
  }
  const capabilities = cachedVendorPermissionCapabilities(vendor) ?? {
    vendor,
    supportedModes: [],
    helpSource: "unavailable-route",
  };
  const resolved = resolvePermissionModeForVendor(capabilities, mode);
  if (!capabilities.supportedModes.includes(resolved)) {
    throw new Error(
      `${vendor} has no verified permission mode for this noninteractive bridge route.`,
    );
  }
  return permissionArgvForVendor(vendor, resolved).args;
}
