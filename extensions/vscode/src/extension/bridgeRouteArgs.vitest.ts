import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatMessage } from "core";
import { afterEach, describe, expect, it, vi } from "vitest";

// bridgeChatAdapter lives in packages/vendor-bridge since phase 2; the source
// contracts below pin the same text at its new location.
const VENDOR_BRIDGE_SRC = path.join(
  __dirname,
  "..", "..", "..", "..",
  "packages", "vendor-bridge", "src",
);

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));
vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});
// The Grok argv-limit fixture below is calibrated against the host scratch
// root length: the spill-file path is counted in the serialized prompt bytes.
// Pin the host storage root explicitly; the library default (system temp) is
// longer on this machine and would trip the image budget before the argv one.
configureBridgeStorageHost({ preferredWindowsScratchRoot: "D:\\Scratch" });

// permissionCapabilities lives in packages/vendor-bridge since phase 2; mock
// the real module id so the mock reaches both the package internals and the
// extension shim.
vi.mock("../../../../packages/vendor-bridge/src/permissionCapabilities", () => ({  cachedVendorPermissionCapabilities: (vendor: string) => ({
    vendor,
    supportedModes:
      vendor === "codex"
        ? ["bypass"]
        : vendor === "deepseek"
          ? []
          : vendor === "qwen"
            ? ["manual", "editAutomatically", "plan", "auto", "bypass"]
            : ["plan", "bypass"],
    helpSource: "test-route",
  }),
}));

import {
  BROKER_NOT_ROUTABLE_GUIDANCE,
  attachClaudePermissionTransport,
  bridgeEventsProveInputAccepted,
  bridgeFailureDetail,
  bridgeProcessExitIsFailure,
  bridgeProcessFailureMessage,
  bridgeProcessFailureTerminalEvent,
  bridgeResumeUserText,
  claudeInitialContent,
  claudeStreamingInput,
  commandCandidates,
  grokBridgeEnv,
  KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16,
  nativeDelegateHint,
  nativePromptCacheArgs,
  queuedFollowUpEchoMessageId,
  BROKER_PROMPT_PREAMBLE,
  isOwnPromptEcho,
  readableFailureReason,
  routeForModel,
  settleBridgeChildError,
  toChatMessages,
  windowsCommandLineUtf16Length,
} from "@cukii/vendor-bridge";
import { ClaudePermissionBroker } from "@cukii/vendor-bridge";
import { configureBridgeStorageHost } from "@cukii/vendor-bridge";
import { resolveBridgeControls } from "@cukii/vendor-bridge";
import { BridgeEventParser } from "@cukii/vendor-bridge";
import {
  cursorCatalogFromOutput,
  grokCatalogFromOutput,
} from "@cukii/vendor-bridge";

const promptFiles: string[] = [];

describe("broker delegation recovery guidance", () => {
  it("does not turn a scope routing failure into a false model/account outage", () => {
    expect(BROKER_NOT_ROUTABLE_GUIDANCE).toContain("task/scope routing error");
    expect(BROKER_NOT_ROUTABLE_GUIDANCE).toContain("never evidence");
    expect(BROKER_NOT_ROUTABLE_GUIDANCE).toContain("route_reason");
    expect(BROKER_NOT_ROUTABLE_GUIDANCE).toContain(
      "explicit known vault scope",
    );
  });

  // Board cards d4c6c6fd/de99bf3d: with subagent routing on Auto the broker
  // refused a scope-less delegation with not_routable, and the model told the
  // owner "route gpt-6-astra is unavailable" although the subscription was
  // connected. The locked branch already carries the guidance; Auto must too.
  it("carries the not_routable semantics into Auto subagent routing as well", () => {
    const source = fs
      .readFileSync(path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const autoAt = source.indexOf('brokerSubagent === "auto"');
    const lockedAt = source.indexOf(
      "`Subagent routing is locked to ${displayBridgeModel(brokerSubagent)}.`",
    );
    expect(autoAt).toBeGreaterThan(-1);
    expect(lockedAt).toBeGreaterThan(autoAt);
    const autoBranch = source.slice(autoAt, lockedAt);
    expect(autoBranch).toContain("BROKER_NOT_ROUTABLE_GUIDANCE");
    expect(autoBranch).toContain("EXPLICIT scope");
    expect(autoBranch).toContain("report that failure explicitly");
  });
});

afterEach(() => {
  for (const file of promptFiles.splice(0)) fs.rmSync(file, { force: true });
  vi.restoreAllMocks();
});

function nativeKimiPaths(): {
  root: string;
  bin: string;
  executable: string;
} {
  const root = path.join(os.homedir(), ".kimi-code");
  const bin = path.join(root, "bin");
  return { root, bin, executable: path.join(bin, "kimi.exe") };
}

function fakeStats(type: "directory" | "file", symbolicLink = false): fs.Stats {
  return {
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => symbolicLink,
  } as fs.Stats;
}

describe("native bridge argv", () => {
  it("does not let a teardown exit code overwrite an explicit terminal receipt", () => {
    expect(bridgeProcessExitIsFailure(1, null, false)).toBe(true);
    expect(bridgeProcessExitIsFailure(null, "SIGKILL", false)).toBe(true);
    expect(bridgeProcessExitIsFailure(null, null, false)).toBe(true);
    expect(bridgeProcessExitIsFailure(1, null, true)).toBe(false);
    expect(bridgeProcessExitIsFailure(null, "SIGKILL", true)).toBe(false);
    expect(bridgeProcessExitIsFailure(0, null, false)).toBe(false);
    expect(bridgeProcessExitIsFailure(0, null, false, true)).toBe(true);
    expect(bridgeProcessExitIsFailure(0, null, true, true)).toBe(false);

    const source = fs.readFileSync(
      path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"),
      "utf8",
    );
    const enqueueAt = source.indexOf(
      "const enqueueVisibleEvents = (events: BridgeEvent[]) => {",
    );
    const closeAt = source.indexOf('child.once("close"', enqueueAt);
    const terminalFailureAt = source.indexOf(
      "const terminalFailure = bridgeProcessFailureTerminalEvent(",
      closeAt,
    );

    expect(enqueueAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(enqueueAt);
    expect(terminalFailureAt).toBeGreaterThan(closeAt);
    expect(source.slice(enqueueAt, closeAt)).toContain(
      'if (event.kind === "complete")',
    );
    expect(source.slice(enqueueAt, closeAt)).toContain(
      "protocolTerminalReceived = true",
    );
    expect(source.slice(closeAt, terminalFailureAt)).toContain(
      "bridgeProcessExitIsFailure(",
    );
    expect(source.slice(closeAt, terminalFailureAt)).toContain(
      'route.stdinFormat === "claude-stream-json"',
    );
    // Failed teardown still throws independently inside `finally`; only the
    // duplicate process-exit verdict is subordinated to the receipt.
    expect(source.slice(closeAt, terminalFailureAt)).toContain(
      "Native bridge process tree did not terminate within the safety budget",
    );
    const terminalFailureTail = source.slice(terminalFailureAt);
    expect(terminalFailureTail).toContain("toChatMessages(terminalFailure)");
    expect(terminalFailureTail).not.toContain("throw error");
    expect(source.slice(closeAt, terminalFailureAt)).toContain(
      "bridgeProcessFailureMessage({",
    );
    // The watchdog is built from the vendor's own startup budget; a bare
    // `new BridgeSilenceWatchdog()` would put Grok back under the 180 s
    // first-output limit its MCP handshakes cannot meet (card CUK-111).
    expect(source).toContain("bridgeSilenceLimits(silenceVendor)");
    expect(source).toContain("bridgeStartupAdvice(silenceVendor, grokMcpFaults)");
    // The MCP preflight only runs for the vendor that adopts foreign servers;
    // making every launch read two configs would tax routes that cannot hit
    // this fault at all (card d10fd9a0).
    expect(source).toContain(
      'silenceVendor === "grok" ? describeGrokMcpFaults() : undefined',
    );
    expect(source).toContain("silenceWatchdog.poll()");
    expect(source).toContain("settledByWatchdog");
    expect(source).toContain("rememberVendorSession");
  });

  // Card CUK-111: Grok's own memory store makes a network call during session
  // setup and prints nothing until it returns — 300.7 s against an endpoint
  // this host cannot reach, versus 14.5 s for the identical run without it.
  it("keeps Grok's private memory store out of a bridge launch", () => {
    expect(grokBridgeEnv("grok-4-6")).toEqual({ GROK_MEMORY: "0" });
    expect(grokBridgeEnv("grok-4-5")).toEqual({ GROK_MEMORY: "0" });
    // The transcript file and the cukii-memory MCP server already carry both
    // the turn's history and the durable memory, so nothing is lost.
    expect(grokBridgeEnv("opus-5")).toEqual({});
    expect(grokBridgeEnv("kimi-k3")).toEqual({});
    expect(grokBridgeEnv("composer-2-5")).toEqual({});
    // The launch must actually carry it, not just compute it.
    const source = fs.readFileSync(
      path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"),
      "utf8",
    );
    expect(source).toContain("...grokBridgeEnv(model)");
  });

  it("localizes a Codex safety-policy block instead of pasting the rejected command", () => {
    const message = bridgeProcessFailureMessage({
      label: "GPT-5.6 Sol",
      detail:
        'ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected(`pwsh -Command ...`) blocked by policy" }',
      code: 1,
      signal: null,
    });
    expect(message).toMatch(/local safety policy blocked a command/);
    expect(message).not.toContain("pwsh");
    expect(message).not.toContain("Rejected");
  });

  it("turns a stopped native process into one visible terminal error receipt", () => {
    const failure = new Error(
      "GPT-5.6 Sol stopped because the local safety policy blocked a command.",
    );

    expect(bridgeProcessFailureTerminalEvent(failure, false, false)).toEqual({
      kind: "terminalError",
      text: failure.message,
    });
    expect(
      bridgeProcessFailureTerminalEvent(failure, true, false),
    ).toBeUndefined();
    expect(
      bridgeProcessFailureTerminalEvent(failure, false, true),
    ).toBeUndefined();
    expect(
      bridgeProcessFailureTerminalEvent(undefined, false, false),
    ).toBeUndefined();
  });

  it("reduces a capacity transcript to one short actionable receipt", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"thousands of transport bytes"}}',
      '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}',
    ].join("\n");

    const message = bridgeProcessFailureMessage({
      label: "GPT-5.6 Sol",
      detail: raw,
      code: 1,
      signal: null,
      logFile: "D:/logs/bridge.log",
    });

    expect(message).toBe(
      "GPT-5.6 Sol is temporarily at capacity. Choose another model or send the message again. Bridge log: D:/logs/bridge.log",
    );
    expect(message).not.toContain("item.completed");
    expect(message).not.toContain("aggregated_output");
  });

  it("finds capacity in stdout even when stderr contains an unrelated warning", () => {
    const detail = bridgeFailureDetail(
      '{"error":"Selected model is at capacity. Please try a different model."}',
      "Warning: optional transport cache unavailable",
    );
    const message = bridgeProcessFailureMessage({
      label: "GPT-5.6 Sol",
      detail,
      code: 1,
      signal: null,
    });

    expect(message).toContain("temporarily at capacity");
    expect(message).not.toContain("optional transport cache");
  });

  it("never pastes an unknown native transcript into the generic fallback", () => {
    const message = bridgeProcessFailureMessage({
      label: "Codex",
      detail:
        '{"type":"item.completed","aggregated_output":"private raw output"}',
      code: 1,
      signal: null,
      logFile: "D:/logs/bridge.log",
    });

    expect(message).toContain("Native CLI stopped before returning");
    expect(message).toContain("D:/logs/bridge.log");
    expect(message).not.toContain("aggregated_output");
    expect(message).not.toContain("private raw output");
  });

  // Card 8011ef2f: Kimi died with a bare `exited with code 1` while its own
  // stderr held the whole explanation, so the user had nothing to act on.
  it("names an exhausted vendor plan as a usage limit and keeps the reset time", () => {
    const message = bridgeProcessFailureMessage({
      label: "Kimi K3",
      detail:
        "Quota exhausted: Your token-plan 1-week quota has been exhausted.\n" +
        "The quota will reset at 09-25 13:28:00 UTC.\n" +
        "(cause: insufficient_quota: 429 Your token-plan 1-week quota has been exhausted.)",
      code: 1,
      signal: null,
    });

    expect(message).toMatch(/usage limit, not a Cukii defect/);
    expect(message).toContain("09-25 13:28:00 UTC");
    expect(message).not.toMatch(/Native CLI stopped before returning/);
  });

  it("carries the last readable native line into the generic receipt", () => {
    const message = bridgeProcessFailureMessage({
      label: "Kimi K3",
      detail:
        '{"type":"item.completed","aggregated_output":"private raw output"}\n' +
        "    at Object.<anonymous> (D:/kimi/index.js:12:9)\n" +
        "Error: MCP server cukii-memory failed to start",
      code: 1,
      signal: null,
    });

    expect(message).toContain(
      "It last said: Error: MCP server cukii-memory failed to start",
    );
    // The transport itself still never reaches the conversation.
    expect(message).not.toContain("aggregated_output");
    expect(message).not.toContain("private raw output");
    expect(message).not.toContain("at Object.");
  });

  it("keeps the generic receipt bare when the native tail is pure transport", () => {
    expect(
      readableFailureReason(
        '{"type":"item.completed","aggregated_output":"x"}\n[1,2,3]\n----\n',
      ),
    ).toBeUndefined();
    // An overlong single line is a payload dump, never a sentence.
    expect(readableFailureReason("word ".repeat(200))).toBeUndefined();
    expect(readableFailureReason("")).toBeUndefined();
    // A genuine sentence is capped rather than dropped.
    const long = `Error: ${"detail ".repeat(40)}`.trim();
    const reason = readableFailureReason(long)!;
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.startsWith("Error: detail")).toBe(true);
  });

  // Card 2d80143f, reported as "Краш какой-то" on 2.0.122: codex reports a
  // failed edit as one ERROR line followed by the whole block of lines it
  // expected to find. The chat filled with the owner's own source rendered as
  // capsules, which reads as a crash dump rather than a failed edit.
  it("does not quote the user's own source back as the failure reason", () => {
    const detail = [
      "2026-09-10T14:00:31.774013Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in [PATH]",
      'it("opens the browser and stores the key only after the API accepts it", async () => {',
      "  const secrets = store();",
      "  const host = authHost(KEY);",
      "expect(result.message).toContain(OWNER);",
      "});",
    ].join("\n");

    const reason = readableFailureReason(detail)!;
    expect(reason).toContain("apply_patch verification failed");
    // The log furniture is not part of the sentence the owner reads.
    expect(reason).not.toContain("codex_core::tools::router");
    expect(reason).not.toMatch(/^\d{4}-/);
    // Nothing from the expected-lines block may surface as "what it said".
    expect(reason).not.toContain("expect(result.message)");
    expect(reason).not.toContain("const secrets");

    const message = bridgeProcessFailureMessage({
      label: "GPT-5.6 Sol",
      detail,
      code: 1,
      signal: null,
    });
    expect(message).toMatch(/could not apply its own patch/i);
    expect(message).toContain("left untouched");
    expect(message).not.toContain("expect(result.message)");
    expect(message).not.toContain("codex_core::tools::router");
  });

  it("keeps an eagerly parsed newline-less terminal receipt authoritative", () => {
    const parser = new BridgeEventParser("codex-thread");
    expect(parser.push('{"type":"turn.completed"}')).toEqual([
      { kind: "complete" },
    ]);
    const nativeError = new Error("late process error");

    const settlement = settleBridgeChildError(parser, nativeError, true);

    expect(settlement.events).toEqual([]);
    expect(settlement.protocolTerminalReceived).toBe(true);
    expect(settlement.error).toBeUndefined();
  });

  it("keeps child error fatal when parser flush has no terminal receipt", () => {
    const parser = new BridgeEventParser("codex-thread");
    expect(parser.push('{"type":"turn.started"}')).toEqual([]);
    const nativeError = new Error("spawn failed");

    const settlement = settleBridgeChildError(parser, nativeError, false);

    expect(settlement.protocolTerminalReceived).toBe(false);
    expect(settlement.error).toBe(nativeError);
  });

  it("emits a queued read receipt only for one exact vendor user echo", () => {
    const messages: Array<ChatMessage & { id: string }> = [
      { role: "user", content: "original", id: "original" },
      { role: "user", content: "follow me", id: "follow-up" },
      { role: "user", content: "and this too", id: "follow-up-2" },
    ];
    expect(
      queuedFollowUpEchoMessageId(
        messages,
        ["follow-up"],
        "follow me",
        new Set(),
      ),
    ).toBe("follow-up");
    expect(
      queuedFollowUpEchoMessageId(
        messages,
        ["follow-up"],
        "bridge instructions\n\nUSER:\nfollow me",
        new Set(),
      ),
    ).toBe("follow-up");
    expect(
      queuedFollowUpEchoMessageId(
        messages,
        ["follow-up"],
        "original",
        new Set(),
      ),
    ).toBeUndefined();
    expect(
      queuedFollowUpEchoMessageId(
        messages,
        ["follow-up", "follow-up-2"],
        "follow me",
        new Set(["follow-up"]),
      ),
    ).toBeUndefined();
    expect(
      queuedFollowUpEchoMessageId(
        messages,
        ["follow-up", "follow-up-2"],
        "and this too",
        new Set(["follow-up"]),
      ),
    ).toBe("follow-up-2");
  });
  it("recognises the vendor replaying this run's own prompt", () => {
    const prompt = [
      BROKER_PROMPT_PREAMBLE,
      "Broker model: Opus 5.",
      "",
      "USER:\nпривет",
      "",
      "ASSISTANT:\nготово",
    ].join("\n");

    // Exact replay, and the clipped/re-wrapped replay a long prompt produces.
    expect(isOwnPromptEcho(prompt, prompt)).toBe(true);
    expect(isOwnPromptEcho(`  ${prompt}\n`, prompt)).toBe(true);
    expect(isOwnPromptEcho(prompt.slice(0, 400), prompt)).toBe(true);
    expect(
      isOwnPromptEcho(`${BROKER_PROMPT_PREAMBLE}\nBroker model: other.`, prompt),
    ).toBe(true);

    // A real user turn keeps its capsule, including one that quotes the
    // preamble while this run sent an ordinary resumed prompt.
    expect(isOwnPromptEcho("привет", prompt)).toBe(false);
    expect(isOwnPromptEcho("Stop hook feedback: missing receipt", prompt)).toBe(
      false,
    );
    expect(isOwnPromptEcho(BROKER_PROMPT_PREAMBLE, "продолжи")).toBe(false);
    expect(isOwnPromptEcho("", prompt)).toBe(false);
    expect(isOwnPromptEcho(prompt, "")).toBe(false);
  });

  it("drops the own-prompt echo instead of rendering it as a user capsule", () => {
    const source = fs
      .readFileSync(path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const branchAt = source.indexOf("const messageId = queuedMessageId");
    expect(branchAt).toBeGreaterThan(-1);
    const branch = source.slice(
      branchAt,
      source.indexOf('if (event.kind === "vendorSession")', branchAt),
    );
    // The guard must sit between the steering receipt and the visible push,
    // and it must swallow rather than render.
    const guardAt = branch.indexOf("isOwnPromptEcho(event.text, prompt)");
    const pushAt = branch.indexOf('queue.push({ kind: "text"');
    expect(guardAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(guardAt);
    expect(branch.slice(guardAt, pushAt)).toContain("continue;");
  });

  it("marks only factual vendor stdout as receipt activity", () => {
    expect(
      toChatMessages({
        kind: "thinking",
        text: "Native bridge first output after 0.1 s.\n",
        vendorActivity: true,
      }),
    ).toEqual([
      {
        role: "thinking",
        content: "Native bridge first output after 0.1 s.\n",
        cukiiVendorActivity: true,
      },
    ]);
    expect(
      toChatMessages({ kind: "thinking", text: "Launching native command" }),
    ).toEqual([{ role: "thinking", content: "Launching native command" }]);
  });

  // win32 only: `kimiWindowsNativeProgram()` (the `.kimi-code\bin\kimi.exe`
  // component chain) is reached only when `process.platform === "win32"`;
  // elsewhere the route falls back to a bare `kimi` on PATH.
  it.runIf(process.platform === "win32")(
    "uses the ordinary native Kimi component chain, without lstat on homedir",
    () => {
      const paths = nativeKimiPaths();
      const lstatSync = vi.spyOn(fs, "lstatSync");
      const route = routeForModel(
        "kimi-k3",
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("kimi-k3", "high", "standard"),
      );
      expect(route.program).toBe(paths.executable);
      expect(lstatSync).toHaveBeenCalledWith(paths.root);
      expect(lstatSync).toHaveBeenCalledWith(paths.bin);
      expect(lstatSync).toHaveBeenCalledWith(paths.executable);
      expect(lstatSync).not.toHaveBeenCalledWith(os.homedir());
    },
  );

  it("routes selected K3 with the exact verified prompt-mode argv", () => {
    const route = routeForModel(
      "kimi-k3",
      "D:/Brain/vault",
      "reply with only K3_CANARY_OK",
      [],
      resolveBridgeControls("kimi-k3", "high", "standard"),
    );
    expect(route.args).toEqual(
      expect.arrayContaining([
        "-p",
        "reply with only K3_CANARY_OK",
        "--output-format",
        "stream-json",
        "-m",
        "kimi-code/k3",
      ]),
    );
    expect(route.args).not.toContain("--auto");
    expect(route.args).not.toContain("--yolo");
    expect(route.args).not.toContain("--plan");
  });

  it("keeps an exact Unicode/multiline Kimi prompt in argv without any Scratch file", () => {
    const prefix = "Первая строка\n🙂 第二行\n";
    const prompt = prefix + "x".repeat(1_024);
    const writeFileSync = vi.spyOn(fs, "writeFileSync");
    const route = routeForModel(
      "kimi-k3",
      "D:/Brain/vault",
      prompt,
      [],
      resolveBridgeControls("kimi-k3", "high", "standard"),
    );
    expect(route.args[route.args.indexOf("-p") + 1]).toBe(prompt);
    expect(route.promptFile).toBeUndefined();
    expect(route.logFile).toBeUndefined();
    expect(route.args.join(" ")).not.toContain("D:\\Scratch\\cukii-bridge");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  // win32 only: the spill exists because CreateProcess has a 32767-character
  // UTF-16 command-line budget, and the spill file itself lives under the
  // fixed Windows root `D:\Scratch\cukii-bridge`. Neither the limit nor that
  // root exists on another platform, so `route.promptFile` stays undefined.
  it.runIf(process.platform === "win32")(
    "spills a quote-storm prompt beyond the CreateProcess limit into an exclusive Scratch file",
    () => {
      const oversized = '\\"'.repeat(12_000);
      const route = routeForModel(
        "kimi-k3",
        "D:/Brain/vault",
        oversized,
        [],
        resolveBridgeControls("kimi-k3", "high", "standard"),
      );
      expect(route.promptFile).toBeDefined();
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(fs.readFileSync(route.promptFile!, "utf8")).toBe(oversized);
      const loader = route.args[route.args.indexOf("-p") + 1];
      expect(loader).toContain(route.promptFile!);
      expect(loader).not.toBe(oversized);
      expect(
        windowsCommandLineUtf16Length(route.program, route.args),
      ).toBeLessThanOrEqual(KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16);
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  // win32 only: same CreateProcess budget and the same `D:\Scratch` spill root.
  it.runIf(process.platform === "win32")(
    "keeps a 100k-unit live transcript launchable through the Kimi spill file",
    () => {
      const transcript =
        "Cukii broker transcript line with session context.\n".repeat(2_500);
      expect(transcript.length).toBeGreaterThan(
        KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16,
      );
      const route = routeForModel(
        "kimi-k3",
        "D:/Brain/vault",
        transcript,
        [],
        resolveBridgeControls("kimi-k3", "high", "standard"),
      );
      expect(route.promptFile).toBeDefined();
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(fs.readFileSync(route.promptFile!, "utf8")).toBe(transcript);
      const loader = route.args[route.args.indexOf("-p") + 1];
      expect(loader).toContain(route.promptFile!);
      const modelIndex = route.args.indexOf("-m");
      expect(route.args[modelIndex + 1]).toBe("kimi-code/k3");
      expect(
        windowsCommandLineUtf16Length(route.program, route.args),
      ).toBeLessThanOrEqual(KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16);
    },
  );

  // win32 only: an npm `.cmd` shim under %APPDATA%\npm and the rule that the
  // native `kimi.exe` must exist are Windows-only. Off Windows the route
  // resolves a bare `kimi` from PATH and never reaches this check.
  it.runIf(process.platform === "win32")(
    "fails closed when only a Kimi cmd shim is present",
    () => {
      const { executable: nativeProgram } = nativeKimiPaths();
      const shim = path.join(
        os.homedir(),
        "AppData",
        "Roaming",
        "npm",
        "kimi.cmd",
      );
      const originalLstat = fs.lstatSync;
      const lstatSync = vi
        .spyOn(fs, "lstatSync")
        .mockImplementation((candidate) => {
          if (String(candidate).toLowerCase() === nativeProgram.toLowerCase()) {
            const error = new Error("ENOENT") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return originalLstat(candidate);
        });
      const existsSync = vi
        .spyOn(fs, "existsSync")
        .mockImplementation((candidate) =>
          String(candidate).toLowerCase() === shim.toLowerCase() ? true : false,
        );
      const writeFileSync = vi.spyOn(fs, "writeFileSync");
      const mkdirSync = vi.spyOn(fs, "mkdirSync");

      expect(() =>
        routeForModel(
          "kimi-k3",
          "D:/Brain/vault",
          "&|<>^%!",
          [],
          resolveBridgeControls("kimi-k3", "high", "standard"),
        ),
      ).toThrow(/is not installed where Cukii launches it/);
      // Card CUK-113: refusing is right, but the old wording ("PATH and shell
      // shims are refused") left a user who installed through npm and logged
      // in successfully with nothing to act on. The refusal has to name both
      // the file this route spawns and the installer that produces it.
      expect(() =>
        routeForModel(
          "kimi-k3",
          "D:/Brain/vault",
          "&|<>^%!",
          [],
          resolveBridgeControls("kimi-k3", "high", "standard"),
        ),
      ).toThrow(
        new RegExp(
          `${nativeProgram.replace(/[\\.]/g, "\\$&")}[\\s\\S]*code\\.kimi\\.com/kimi-code/install\\.ps1`,
        ),
      );
      expect(lstatSync).toHaveBeenCalledWith(nativeProgram);
      expect(existsSync).not.toHaveBeenCalledWith(shim);
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  // win32 only: a junction/reparse point is how Node reports this on Windows,
  // and the component chain it guards is only walked there.
  it.runIf(process.platform === "win32")(
    "rejects a reparse/junction Kimi parent before any side effect",
    () => {
      const paths = nativeKimiPaths();
      const originalLstat = fs.lstatSync;
      const lstatSync = vi
        .spyOn(fs, "lstatSync")
        .mockImplementation((candidate) => {
          if (String(candidate).toLowerCase() === paths.root.toLowerCase()) {
            // On Windows Node presents a junction/reparse point as lstat
            // symbolic-link metadata; the component must not be traversed.
            return fakeStats("directory", true);
          }
          return originalLstat(candidate);
        });
      const writeFileSync = vi.spyOn(fs, "writeFileSync");
      const mkdirSync = vi.spyOn(fs, "mkdirSync");
      expect(() =>
        routeForModel(
          "kimi-k3",
          "D:/Brain/vault",
          "&|<>^%!",
          [],
          resolveBridgeControls("kimi-k3", "high", "standard"),
        ),
      ).toThrow(/Refusing to launch Kimi through/);
      expect(lstatSync).toHaveBeenCalledWith(paths.root);
      expect(lstatSync).not.toHaveBeenCalledWith(paths.bin);
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  // win32 only: the symlink check belongs to the same Windows-only
  // `.kimi-code\bin\kimi.exe` component chain.
  it.runIf(process.platform === "win32")(
    "rejects a final Kimi executable symlink before any side effect",
    () => {
      const paths = nativeKimiPaths();
      const originalLstat = fs.lstatSync;
      const lstatSync = vi
        .spyOn(fs, "lstatSync")
        .mockImplementation((candidate) => {
          const pathKey = String(candidate).toLowerCase();
          if (pathKey === paths.root.toLowerCase()) {
            return fakeStats("directory");
          }
          if (pathKey === paths.bin.toLowerCase()) {
            return fakeStats("directory");
          }
          if (pathKey === paths.executable.toLowerCase()) {
            return fakeStats("file", true);
          }
          return originalLstat(candidate);
        });
      const writeFileSync = vi.spyOn(fs, "writeFileSync");
      const mkdirSync = vi.spyOn(fs, "mkdirSync");
      expect(() =>
        routeForModel(
          "kimi-k3",
          "D:/Brain/vault",
          "&|<>^%!",
          [],
          resolveBridgeControls("kimi-k3", "high", "standard"),
        ),
      ).toThrow(/Refusing to launch Kimi through/);
      expect(lstatSync).toHaveBeenCalledWith(paths.root);
      expect(lstatSync).toHaveBeenCalledWith(paths.bin);
      expect(lstatSync).toHaveBeenCalledWith(paths.executable);
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnSync).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact full CreateProcess command-line boundary", () => {
    const emptyRoute = routeForModel(
      "kimi-k3",
      "D:/Brain/vault",
      "",
      [],
      resolveBridgeControls("kimi-k3", "high", "standard"),
    );
    const promptIndex = emptyRoute.args.indexOf("-p") + 1;
    const maxAsciiPromptLength =
      KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16 -
      windowsCommandLineUtf16Length(emptyRoute.program, emptyRoute.args) +
      2;
    const prompt = "x".repeat(maxAsciiPromptLength);
    const route = routeForModel(
      "kimi-k3",
      "D:/Brain/vault",
      prompt,
      [],
      resolveBridgeControls("kimi-k3", "high", "standard"),
    );
    expect(route.args[promptIndex]).toBe(prompt);
    expect(windowsCommandLineUtf16Length(route.program, route.args)).toBe(
      KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16,
    );
  });

  it("rejects an overlong dynamic Kimi alias before any route artefact", () => {
    const writeFileSync = vi.spyOn(fs, "writeFileSync");
    expect(() =>
      routeForModel(
        `kimi:${"a".repeat(129)}`,
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("kimi-k3", "high", "standard"),
      ),
    ).toThrow(/native model alias/);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("serializes the exact Claude stream-json user envelope for Unicode and newlines", () => {
    const text = "Первая строка\n🙂 第二行\nпоследняя";
    const frame = claudeStreamingInput(text);
    expect(frame.endsWith("\n")).toBe(true);
    expect(JSON.parse(frame)).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    });
  });

  it("serializes a Claude live steer with its image attachment in the same envelope", () => {
    const frame = claudeStreamingInput([
      { type: "text", text: "inspect this" },
      {
        type: "imageUrl",
        imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
      },
    ]);

    expect(JSON.parse(frame)).toMatchObject({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "inspect this" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
        ],
      },
    });
  });

  it("canonicalizes the legacy image/jpg label at Claude's live boundary", () => {
    const frame = claudeStreamingInput([
      {
        type: "imageUrl",
        imageUrl: { url: "data:image/jpg;base64,aW1hZ2U=" },
      },
    ]);

    expect(JSON.parse(frame).message.content[0].source.media_type).toBe(
      "image/jpeg",
    );
  });

  it("rejects SVG at Claude's live vision boundary instead of mislabelling it", () => {
    expect(() =>
      claudeStreamingInput([
        {
          type: "imageUrl",
          imageUrl: { url: "data:image/svg+xml;base64,PHN2Zy8+" },
        },
      ]),
    ).toThrow(/JPEG, PNG, GIF, or WebP.*did not drop/i);
  });

  it("rejects an unsupported live image before a text-only envelope can be written", () => {
    expect(() =>
      claudeStreamingInput([
        { type: "text", text: "inspect this" },
        { type: "imageUrl", imageUrl: { url: "file:///D:/image.png" } },
      ]),
    ).toThrow(/JPEG, PNG, GIF, or WebP.*did not drop/i);
  });

  it("re-attaches the current turn's data-URL images to the Claude cold start", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "imageUrl",
            imageUrl: { url: "data:image/png;base64,aW1hZ2U=" },
          },
          { type: "imageUrl", imageUrl: { url: "https://example.com/x.png" } },
        ],
      },
    ];

    const content = claudeInitialContent("transcript prompt", messages);
    // The cold-start envelope must stay writable: remote URLs remain
    // materialized paths in the transcript text, never native blocks.
    expect(() => claudeStreamingInput(content)).not.toThrow();
    expect(JSON.parse(claudeStreamingInput(content))).toMatchObject({
      message: {
        content: [
          { type: "text", text: "transcript prompt" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png" },
          },
        ],
      },
    });
  });

  it("rejects a restored SVG before constructing Claude's cold-start envelope", () => {
    expect(() =>
      claudeInitialContent("transcript prompt", [
        {
          role: "user",
          content: [
            {
              type: "imageUrl",
              imageUrl: { url: "data:image/svg+xml;base64,PHN2Zy8+" },
            },
          ],
        },
      ]),
    ).toThrow(/JPEG, PNG, GIF, or WebP.*did not drop/i);
  });

  // win32 only: `ClaudePermissionBroker` allocates a Windows named pipe
  // (`\\.\pipe\…`) and its config directory under the fixed Windows root
  // `D:\Scratch\cukii-permission`; constructing it anywhere else throws ENOENT
  // before this transport contract can be observed.
  it.runIf(process.platform === "win32")(
    "adds the real Claude MCP permission transport without leaking its token",
    async () => {
      const route = routeForModel(
        "opus-5",
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("opus-5", "high", "standard"),
        "manual",
      );
      const broker = new ClaudePermissionBroker({
        panelId: "panel-a",
        sessionId: "session-a",
        mode: "manual",
        onRequest: () => {},
      });
      await broker.start();
      try {
        attachClaudePermissionTransport(route, broker);
        expect(route.args.slice(-7)).toEqual([
          "--mcp-config",
          broker.configPath,
          "--strict-mcp-config",
          "--allowed-tools",
          "mcp__cukii_permission__request",
          "--permission-prompt-tool",
          "mcp__cukii_permission__request",
        ]);
        expect(route.args.join(" ")).not.toContain(broker.token);
      } finally {
        await broker.dispose();
      }
    },
  );

  it("does not write the Grok transcript to stdin", () => {
    const source = fs.readFileSync(
      path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"),
      "utf8",
    );
    const grokAt = source.indexOf("function grokRoute(");
    const nextFn = source.indexOf("\nfunction ", grokAt + 1);
    expect(grokAt).toBeGreaterThan(-1);
    expect(source.slice(grokAt, nextFn)).toContain("noStdin: true");
  });

  it("does not render a captured native session id as chat text", () => {
    expect(toChatMessages({ kind: "vendorSession", id: "9252c6e5" })).toEqual(
      [],
    );
  });

  it("resumes a captured Claude session instead of rebuilding the transcript", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old task" },
      { role: "assistant", content: "working" },
      { role: "user", content: "continue from the stop" },
    ];
    expect(bridgeResumeUserText(messages)).toBe("continue from the stop");
    const route = routeForModel(
      "fable-5-1",
      "D:/Brain/vault",
      "continue from the stop",
      messages,
      resolveBridgeControls("fable-5-1", "medium", "standard"),
      "bypass",
      "9252c6e5-aaaa-bbbb-cccc-ddddeeeeffff",
    );
    const resumeAt = route.args.indexOf("--resume");
    expect(resumeAt).toBeGreaterThan(-1);
    expect(route.args[resumeAt + 1]).toBe(
      "9252c6e5-aaaa-bbbb-cccc-ddddeeeeffff",
    );
    expect(route.args).not.toContain("old task");
  });

  it("wires independent Claude effort and speed into the native CLI", () => {
    const controls = resolveBridgeControls("opus-5", "xhigh", "fast");
    const route = routeForModel(
      "opus-5",
      "D:/Brain/vault",
      "prompt",
      [],
      controls,
    );
    expect(route.args).toEqual([
      "--model",
      "claude-opus-5",
      "--exclude-dynamic-system-prompt-sections",
      "--effort",
      "xhigh",
      "--settings",
      '{"fastMode":true,"alwaysThinkingEnabled":true}',
      "--dangerously-skip-permissions",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
    ]);
  });

  it("routes Fable 5.1 through the exact verified Claude argv", () => {
    const route = routeForModel(
      "fable-5-1",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("fable-5-1", "high", "standard"),
    );
    // The catalog prefers the self-updating native build when installed, so
    // only the Claude executable identity is stable across machines.
    expect(route.program).toMatch(/(?:^|[\\/])claude(?:\.exe)?$/i);
    expect(route.format).toBe("anthropic-envelope");
    expect(route.stdinFormat).toBe("claude-stream-json");
    expect(route.args).toEqual([
      "--model",
      "claude-fable-5-1",
      "--exclude-dynamic-system-prompt-sections",
      "--effort",
      "high",
      "--settings",
      '{"fastMode":false}',
      "--dangerously-skip-permissions",
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
    ]);
  });

  it.each([
    ["opus-5", true],
    ["fable-5-1", true],
    ["haiku-4-5", true],
    ["codex-5-6-terra", false],
    ["composer-2-5", false],
    ["qwen-3-8-max", false],
  ] as const)(
    "uses only the native prompt-cache contract for %s",
    (model, hasClaudeDefaultSystemFlag) => {
      const route = routeForModel(
        model,
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls(model, "high", "standard"),
        model.startsWith("codex") || model.startsWith("qwen")
          ? "bypass"
          : "manual",
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(nativePromptCacheArgs(model)).toEqual(
        hasClaudeDefaultSystemFlag
          ? ["--exclude-dynamic-system-prompt-sections"]
          : [],
      );
      expect(
        route.args.includes("--exclude-dynamic-system-prompt-sections"),
      ).toBe(hasClaudeDefaultSystemFlag);
      if (!hasClaudeDefaultSystemFlag) {
        expect(route.args.join(" ")).not.toMatch(/(?:^|[- ])cache(?:[- =]|$)/i);
      }
    },
  );

  it.each(["codex-5-6-terra", "codex-5-6-sol"] as const)(
    "wires Codex %s effort and priority tier before exec",
    (model) => {
      const route = routeForModel(
        model,
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls(model, "medium", "fast"),
        "bypass",
      );
      expect(route.args.slice(0, 9)).toEqual([
        "-m",
        model === "codex-5-6-terra" ? "gpt-5.6-terra" : "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="medium"',
        "-c",
        'service_tier="priority"',
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ]);
    },
  );

  it("routes a live GPT-6 Astra catalog id with native effort and Fast", () => {
    const model = "codex:gpt-6-astra";
    const route = routeForModel(
      model,
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls(model, "ultra", "fast"),
      "bypass",
    );
    expect(route.args.slice(0, 9)).toEqual([
      "-m",
      "gpt-6-astra",
      "-c",
      'model_reasoning_effort="max"',
      "-c",
      'service_tier="priority"',
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("disables Codex reasoning through the real native none value", () => {
    const route = routeForModel(
      "codex-5-6-terra",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("codex-5-6-terra", "medium", "fast", false),
      "bypass",
    );
    expect(route.args).toContain('model_reasoning_effort="none"');
    expect(route.args).toContain('service_tier="priority"');
  });

  it("routes only verified noninteractive modes to non-conflicting flag sets", () => {
    const cases = [
      [
        "opus-5",
        "plan",
        "--permission-mode plan",
        "--dangerously-skip-permissions",
      ],
      [
        "opus-5",
        "bypass",
        "--dangerously-skip-permissions",
        "--permission-mode",
      ],
      [
        "codex-5-6-terra",
        "bypass",
        "--dangerously-bypass-approvals-and-sandbox",
        "--approve-for-me",
      ],
      ["composer-2-5", "plan", "--plan", "--trust"],
      [
        "qwen-3-8-max",
        "bypass",
        "--approval-mode yolo",
        "--approval-mode default",
      ],
    ] as const;

    for (const [model, mode, required, forbidden] of cases) {
      const route = routeForModel(
        model,
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls(model, "high", "standard"),
        mode,
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args.join(" ")).toContain(required);
      expect(route.args.join(" ")).not.toContain(forbidden);
    }
  });

  // win32 only: `grokRoute` always spills its transcript into the fixed
  // Windows root `D:\Scratch\cukii-bridge` before it produces any argv, so the
  // Grok case of the table above cannot be routed where that root is absent.
  it.runIf(process.platform === "win32")(
    "routes only the verified Grok noninteractive mode to a non-conflicting flag set",
    () => {
      const route = routeForModel(
        "grok-4-6",
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("grok-4-6", "high", "standard"),
        "plan",
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args.join(" ")).toContain("--permission-mode plan");
      expect(route.args.join(" ")).not.toContain("--always-approve");
      expect(route.args).toContain("--include-partial-messages");
      expect(route.noStdin).toBe(true);
    },
  );

  it("auto-approves Cursor MCP so cukii-memory is visible in headless -p", () => {
    const route = routeForModel(
      "composer-2-5",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("composer-2-5", "high", "standard"),
      "bypass",
    );
    expect(route.args).toContain("--approve-mcps");
    expect(route.args).toContain("--stream-partial-output");
    expect(route.args.join(" ")).toContain("--force");
  });

  it.each([
    ["manual", "default"],
    ["editAutomatically", "auto-edit"],
    ["plan", "plan"],
    ["auto", "auto"],
    ["bypass", "yolo"],
  ] as const)(
    "carries Qwen %s through the production route as --approval-mode %s",
    (mode, nativeMode) => {
      const route = routeForModel(
        "qwen-3-8-max",
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("qwen-3-8-max", "high", "standard"),
        mode,
      );
      const approvalIndex = route.args.indexOf("--approval-mode");
      expect(approvalIndex).toBeGreaterThan(-1);
      expect(route.args[approvalIndex + 1]).toBe(nativeMode);
      expect(
        route.args.filter((arg) => arg === "--approval-mode"),
      ).toHaveLength(1);
    },
  );

  it.each(["manual", "editAutomatically", "plan", "auto"] as const)(
    "never escalates Qwen %s to --approval-mode yolo",
    (mode) => {
      const route = routeForModel(
        "qwen-3-8-max",
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("qwen-3-8-max", "high", "standard"),
        mode,
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args.join(" ")).not.toContain("--approval-mode yolo");
    },
  );

  it("keeps nested delegate hints on the selected, verified permission route", () => {
    const codexBypass = nativeDelegateHint(
      "codex-5-6-terra",
      "D:/Brain/vault",
      "bypass",
    );
    expect(codexBypass).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(codexBypass).not.toContain("danger-full-access");

    const qwenPlan = nativeDelegateHint(
      "qwen-3-8-max",
      "D:/Brain/vault",
      "plan",
    );
    expect(qwenPlan).toContain("--approval-mode plan");
    expect(qwenPlan).not.toContain("--approval-mode yolo");
    expect(qwenPlan).toContain("qwen --model qwen3.8-max ");
    expect(qwenPlan).not.toContain("qwen3.8-max-preview");

    expect(() =>
      nativeDelegateHint("codex-5-6-terra", "D:/Brain/vault", "manual"),
    ).toThrow("no verified permission mode");
  });

  it("accepts the exact restored Codex Bypass route without a permission error", () => {
    expect(() =>
      nativeDelegateHint("codex-5-6-terra", "D:/Brain/vault", "bypass"),
    ).not.toThrow();
    expect(
      nativeDelegateHint("codex-5-6-terra", "D:/Brain/vault", "bypass"),
    ).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(() =>
      nativeDelegateHint("codex-5-6-terra", "D:/Brain/vault", "manual"),
    ).toThrow("no verified permission mode");
  });

  // win32 only: every Grok route first spills its transcript into the fixed
  // Windows root `D:\Scratch\cukii-bridge`, which cannot be created elsewhere.
  it.runIf(process.platform === "win32")(
    "wires Grok reasoning effort and reports no fake fast tier",
    () => {
      const controls = resolveBridgeControls("grok-4-6", "max", "fast");
      const route = routeForModel(
        "grok-4-6",
        "D:/Brain/vault",
        "prompt",
        [],
        controls,
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args).toContain("--reasoning-effort");
      expect(route.args[route.args.indexOf("--reasoning-effort") + 1]).toBe(
        "xhigh",
      );
      expect(controls.effectiveSpeed).toBe("standard");
    },
  );

  // win32 only: the limit under test is CreateProcess's fully quoted UTF-16
  // command-line budget, and reaching it requires the Windows spill file.
  it.runIf(process.platform === "win32")(
    "rejects a Grok route above the fully quoted Windows argv limit",
    () => {
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: Array.from({ length: 515 }, () => ({
            type: "imageUrl" as const,
            imageUrl: { url: "data:image/png;base64,AA==" },
          })),
        },
      ];
      let returnedPromptFile: string | undefined;
      let thrown: unknown;
      try {
        const route = routeForModel(
          "grok-4-6",
          "D:/Brain/vault",
          "prompt",
          messages,
          resolveBridgeControls("grok-4-6", "max", "standard"),
        );
        returnedPromptFile = route.promptFile;
      } catch (error) {
        thrown = error;
      } finally {
        if (returnedPromptFile) promptFiles.push(returnedPromptFile);
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(
        /Grok command line.*UTF-16.*did not start/i,
      );
    },
  );

  // win32 only: the catalog parse is cross-platform (and covered by
  // bridgeModelCatalog.vitest.ts), but asserting the routed `--model` needs the
  // Grok spill file under `D:\Scratch\cukii-bridge`.
  it.runIf(process.platform === "win32")(
    "routes a newly discovered xAI model with its exact native id",
    () => {
      const [catalogModel] = grokCatalogFromOutput("  - grok-4.7\n");
      expect(catalogModel.value).toBe("grok:grok-4.7");
      const route = routeForModel(
        catalogModel.value,
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls(catalogModel.value, "high", "standard"),
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args[route.args.indexOf("--model") + 1]).toBe("grok-4.7");
    },
  );

  it("switches Cursor to its real Fast model id", () => {
    const route = routeForModel(
      "composer-2-5",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("composer-2-5", "high", "fast"),
    );
    expect(route.args.join(" ")).toContain("composer-2.5-fast");
  });

  it("routes a live Cursor subscription family through its matching native variant", () => {
    cursorCatalogFromOutput(
      "gpt-5.6-luna-high - GPT-5.6 Luna 1M High\n" +
        "gpt-5.6-luna-high-fast - GPT-5.6 Luna High Fast\n",
    );
    const model = "cursor:gpt-5.6-luna";
    const route = routeForModel(
      model,
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls(model, "high", "fast"),
    );
    expect(route.args.join(" ")).toContain("gpt-5.6-luna-high-fast");
  });

  it("routes a dynamically discovered Moonshot subscription alias unchanged", () => {
    const route = routeForModel(
      "kimi:managed:kimi-code/k4",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("kimi:managed:kimi-code/k4", "high", "standard"),
    );
    expect(route.args).toContain("-m");
    expect(route.args[route.args.indexOf("-m") + 1]).toBe(
      "managed:kimi-code/k4",
    );
  });

  it("pins Qwen production argv to qwen3.8-max, not the obsolete preview id", () => {
    const route = routeForModel(
      "qwen-3-8-max",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("qwen-3-8-max", "high", "standard"),
    );
    if (route.promptFile) promptFiles.push(route.promptFile);
    expect(route.args[route.args.indexOf("--model") + 1]).toBe("qwen3.8-max");
    expect(route.args).not.toContain("--safe-mode");
    expect(route.args.join(" ")).not.toContain("qwen3.8-max-preview");
    expect(route.args.join(" ")).not.toMatch(/preview/i);
  });

  it("pins legacy K2 to the exact managed subscription model", () => {
    const route = routeForModel(
      "kimi-k2",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("kimi-k2", "high", "standard"),
    );
    expect(route.args).toContain("-m");
    expect(route.args[route.args.indexOf("-m") + 1]).toBe(
      "kimi-code/kimi-for-coding",
    );
  });

  it.each(["kimi-k2", "kimi-k3", "qwen-3-8-max"] as const)(
    "keeps %s on standard speed instead of silently inventing a vendor flag",
    (model) => {
      const controls = resolveBridgeControls(model, "high", "fast");
      expect(controls.speedTransport).toBe("unavailable");
      expect(controls.effectiveSpeed).toBe("standard");
      const route = routeForModel(
        model,
        "D:/Brain/vault",
        "prompt",
        [],
        controls,
      );
      if (route.promptFile) promptFiles.push(route.promptFile);
      expect(route.args.join(" ")).not.toMatch(
        /service_tier|fastMode|\bfast\b/,
      );
    },
  );

  it("keeps the existing DeepSeek transport failure explicit", () => {
    expect(() =>
      routeForModel(
        "deepseek-v4-pro",
        "D:/Brain/vault",
        "prompt",
        [],
        resolveBridgeControls("deepseek-v4-pro", "high", "fast"),
      ),
    ).toThrow("DeepSeek bridge is not connected yet");
  });

  it("routes Alibaba chat models through native Qwen compatible argv", () => {
    const route = routeForModel(
      "qwen-3-8-max",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("qwen-3-8-max", "high", "standard"),
      "bypass",
    );
    expect(route.program).toBe("qwen");
    expect(route.args.slice(0, 4)).toEqual([
      "--model",
      "qwen3.8-max",
      "--prompt",
      "Follow the Cukii broker instructions supplied on stdin.",
    ]);
    expect(route.args).not.toContain("--safe-mode");
    expect(route.args).toContain("stream-json");
    expect(route.args.join(" ")).not.toContain("qwen3.8-max-preview");
    expect(route.args.join(" ")).not.toContain("anthropic");
    expect(nativeDelegateHint("qwen-glm-5-2", "D:/Brain/vault", "plan")).toBe(
      'qwen --model glm-5.2 --prompt "<task>" --output-format stream-json --approval-mode plan',
    );
  });

  it("does not invent fake chat routes for Alibaba image/audio/video models", () => {
    for (const model of [
      "qwen-image-3.0-pro",
      "qwen-audio-3.0-asr-flash",
      "qwen-audio-3.0-tts-plus",
      "qwen-audio-3.0-realtime-plus",
      "wan2.7-image",
      "wan2.7-image-pro",
      "happyhorse-1.1-i2v",
      "happyhorse-1.1-t2v",
      "happyhorse-1.1-r2v",
    ]) {
      expect(() =>
        routeForModel(
          model,
          "D:/Brain/vault",
          "prompt",
          [],
          resolveBridgeControls("qwen-3-8-max", "high", "standard"),
        ),
      ).toThrow("Coming soon");
    }
  });

  it("maps a steer read receipt to a private transport frame, never visible text", () => {
    expect(
      toChatMessages({ kind: "steerRead", messageId: "follow-up" }),
    ).toEqual([
      { role: "thinking", content: "", cukiiSteerReadMessageId: "follow-up" },
    ]);
  });

  it("accepts only structured model activity, never startup/error stdout", () => {
    expect(bridgeEventsProveInputAccepted([])).toBe(false);
    expect(
      bridgeEventsProveInputAccepted([{ kind: "error", text: "auth failed" }]),
    ).toBe(false);
    expect(
      bridgeEventsProveInputAccepted([
        { kind: "terminalError", text: "quota" },
        { kind: "complete" },
      ]),
    ).toBe(false);
    expect(bridgeEventsProveInputAccepted([{ kind: "complete" }], true)).toBe(
      false,
    );
    expect(bridgeEventsProveInputAccepted([{ kind: "complete" }])).toBe(true);
    expect(
      bridgeEventsProveInputAccepted([{ kind: "thinking", text: "working" }]),
    ).toBe(true);
    expect(
      bridgeEventsProveInputAccepted([
        { kind: "text", text: "partial answer" },
        { kind: "terminalError", text: "later failure" },
      ]),
    ).toBe(true);
  });

  it("acknowledges a redelivered follow-up only after structured vendor acceptance", () => {
    const source = fs.readFileSync(
      path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"),
      "utf8",
    );
    const handoffAt = source.indexOf("child.stdin.write(");
    const stdoutAt = source.indexOf('child.stdout.on("data"');
    const ackAt = source.indexOf(
      'queue.push({ kind: "steerRead", messageId });',
      stdoutAt,
    );
    expect(handoffAt).toBeGreaterThan(-1);
    expect(stdoutAt).toBeGreaterThan(handoffAt);
    expect(ackAt).toBeGreaterThan(stdoutAt);
    // Spawn or arbitrary stdout is not delivery. Every batch member is
    // acknowledged only after the parser produced an accepting event.
    const ackBlock = source.slice(stdoutAt, ackAt);
    expect(ackBlock).toContain(
      "bridgeEventsProveInputAccepted(events, inputFailureObserved)",
    );
    expect(ackBlock).toContain("markBridgeInboxMessagesRead");
    expect(ackBlock).toContain(
      "for (const messageId of queuedFollowUpMessageIds)",
    );
    expect(ackBlock).toContain("queuedFollowUpRead.has(messageId)");
    expect(ackBlock).toContain('status !== "read"');
    expect(ackBlock).toContain('status !== "absent"');
    expect(source).not.toContain('child.once("spawn"');
  });

  it("swallows a vendor echo of an already-acknowledged follow-up", () => {
    const source = fs.readFileSync(
      path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"),
      "utf8",
    );
    const swallowAt = source.indexOf(
      "if (queuedMessageId && queuedFollowUpRead.has(queuedMessageId)) {",
    );
    expect(swallowAt).toBeGreaterThan(-1);
    const swallowBlock = source.slice(
      swallowAt,
      source.indexOf("const messageId = queuedMessageId", swallowAt),
    );
    expect(swallowBlock).toContain("continue;");
    expect(swallowBlock).not.toContain("queue.push");
    // The matcher must advance past already-read ids. Passing a fresh Set on
    // every echo made two equal follow-ups map to the first id forever.
    const matcherCall = source.slice(
      source.indexOf("const queuedMessageId = queuedFollowUpEchoMessageId("),
      swallowAt,
    );
    expect(matcherCall).toContain("queuedFollowUpRead,");
    expect(matcherCall).not.toContain("new Set(),");
  });

  it("selects the image carrier before prompt, route, and process launch", () => {
    const source = fs
      .readFileSync(path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const selectAt = source.indexOf(
      "const transportMessages = selectBridgeImageSources(",
    );
    const promptAt = source.indexOf("const prompt = buildPrompt(", selectAt);
    const routeAt = source.indexOf("const route = routeForModel(", promptAt);
    const launchAt = source.indexOf("const launchOptions = {", routeAt);
    const launchEnd = source.indexOf("let codexCacheRetried", launchAt);

    expect(selectAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(selectAt);
    expect(routeAt).toBeGreaterThan(promptAt);
    expect(launchAt).toBeGreaterThan(routeAt);

    const transportBlock = source.slice(selectAt, launchEnd);
    expect(transportBlock).toContain(
      "imageScope.materializeMessages(transportMessages)",
    );
    expect(transportBlock).toContain("hasImageAttachment(transportMessages)");
    expect(transportBlock).toContain(
      `routeForModel(
    args.brokerModel,
    cwd,
    prompt,
    transportMessages,`,
    );
    expect(transportBlock).toContain("messages: transportMessages");
    expect(transportBlock).not.toContain(
      "materializeBridgeImages(args.messages)",
    );
    expect(transportBlock).not.toContain("hasImageAttachment(args.messages)");

    const messengerSource = fs
      .readFileSync(path.join(__dirname, "VsCodeMessenger.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    expect(messengerSource).toContain("imageScope,");
    const persistInboxAt = messengerSource.indexOf(
      "run.imageScope.persistInboxMessage(",
    );
    const deliverAt = messengerSource.indexOf(
      "return run.steering.deliver(msg.data);",
      persistInboxAt,
    );
    expect(persistInboxAt).toBeGreaterThan(-1);
    expect(deliverAt).toBeGreaterThan(persistInboxAt);
    const persistInboxBlock = messengerSource.slice(persistInboxAt, deliverAt);
    expect(persistInboxBlock).toContain("(materializedContent, metadata) =>");
    expect(persistInboxBlock).toContain("writeBridgeInboxMessageWithReceipt(");
    expect(persistInboxBlock).toContain("materializedContent,");
    expect(persistInboxBlock).toContain("metadata,");
    expect(persistInboxBlock).toContain("sessionId: run.sessionId");
    expect(persistInboxBlock).not.toContain("materializeMessageContent(");
    expect(messengerSource).toContain("imageScope.dispose()");
  });

  it("rechecks Grok after resolving its final Windows executable", () => {
    const source = fs
      .readFileSync(path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const resolveAt = source.indexOf(
      "command = ensureProgramAvailable(route);",
    );
    const assertAt = source.indexOf(
      "assertGrokWindowsCommandLine(command.program, command.args);",
      resolveAt,
    );
    const launchAt = source.indexOf("const launchOptions = {", resolveAt);

    expect(resolveAt).toBeGreaterThan(-1);
    expect(assertAt).toBeGreaterThan(resolveAt);
    expect(launchAt).toBeGreaterThan(assertAt);
  });

  it("does not paint a live-steer read receipt on stdin write success (ID-238)", () => {
    const source = fs
      .readFileSync(path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const writerAt = source.indexOf(
      "permissionTransport?.steering?.attachWriter(async (message) => {",
    );
    const writerEnd = source.indexOf("});", writerAt);
    const writer = source.slice(writerAt, writerEnd);
    expect(writerAt).toBeGreaterThan(-1);
    expect(writer).toContain("resolve(!error)");
    expect(writer).not.toContain("acknowledgeWritten");
    expect(writer).not.toContain('kind: "steerRead"');
    expect(source).toContain(
      "shouldHoldBridgeTerminal(permissionTransport?.steering)",
    );
    expect(source).toContain('CUKII_INBOX_GRACE_MS: "0"');
    expect(source).toContain("--replay-user-messages");
  });
});

// 🔴 The owner's Accounts row showed Anthropic signed in while starting an
// Opus 5 session answered "Opus 5 bridge is unavailable: cannot start
// \"claude\"" (board card f236681a, Cukii 2.0.132 on darwin). The row and the
// bridge disagreed because only the row resolved an absolute path: a GUI
// VS Code takes PATH from `path_helper`, which never lists `~/.local/bin`, so
// on macOS the bridge was left with a bare name and nothing to find.
describe("unix vendor CLI resolution", () => {
  it.each(["darwin", "linux"] as const)(
    "looks in the Cukii install locations before PATH on %s",
    (platform) => {
      expect(commandCandidates("claude", platform, "/Users/owner")).toEqual([
        "/Users/owner/.local/share/cukii/node/bin/claude",
        "/Users/owner/.local/bin/claude",
        "claude",
      ]);
    },
  );

  it("keeps PATH as the last resort, never the first answer", () => {
    const candidates = commandCandidates("codex", "darwin", "/Users/owner");
    const installed = candidates.indexOf("/Users/owner/.local/bin/codex");
    // Assert presence before order: comparing indexes alone passes vacuously
    // when the explicit location is absent, which is the regression itself.
    expect(installed).toBeGreaterThanOrEqual(0);
    expect(candidates.at(-1)).toBe("codex");
    expect(installed).toBeLessThan(candidates.indexOf("codex"));
  });

  it("leaves an explicit path alone on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        commandCandidates("/opt/homebrew/bin/claude", platform, "/Users/owner"),
      ).toEqual(["/opt/homebrew/bin/claude"]);
    }
  });

  it("still probes the Windows product locations on win32", () => {
    const candidates = commandCandidates("codex", "win32", "C:\\Users\\owner");
    expect(candidates).not.toContain(
      "C:\\Users\\owner/.local/share/cukii/node/bin/codex",
    );
    expect(candidates.at(-1)).toBe("codex");
  });
});
