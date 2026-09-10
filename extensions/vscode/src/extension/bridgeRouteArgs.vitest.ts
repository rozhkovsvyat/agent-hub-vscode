import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatMessage } from "core";
import { afterEach, describe, expect, it, vi } from "vitest";

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
vi.mock("./permissionCapabilities", () => ({
  cachedVendorPermissionCapabilities: (vendor: string) => ({
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
  attachClaudePermissionTransport,
  bridgeEventsProveInputAccepted,
  bridgeFailureDetail,
  bridgeProcessExitIsFailure,
  bridgeProcessFailureMessage,
  bridgeProcessFailureTerminalEvent,
  claudeInitialContent,
  claudeStreamingInput,
  KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16,
  nativeDelegateHint,
  nativePromptCacheArgs,
  queuedFollowUpEchoMessageId,
  routeForModel,
  settleBridgeChildError,
  toChatMessages,
  windowsCommandLineUtf16Length,
} from "./bridgeChatAdapter";
import { ClaudePermissionBroker } from "./claudePermissionBroker";
import { resolveBridgeControls } from "./bridgeControls";
import { BridgeEventParser } from "./bridgeEvents";
import {
  cursorCatalogFromOutput,
  grokCatalogFromOutput,
} from "./bridgeModelCatalog";

const promptFiles: string[] = [];
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
      path.join(__dirname, "bridgeChatAdapter.ts"),
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

  it("uses the ordinary native Kimi component chain, without lstat on homedir", () => {
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
  });

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

  it("spills a quote-storm prompt beyond the CreateProcess limit into an exclusive Scratch file", () => {
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
  });

  it("keeps a 100k-unit live transcript launchable through the Kimi spill file", () => {
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
  });

  it("fails closed when only a Kimi cmd shim is present", () => {
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
    ).toThrow(/native executable is required/);
    expect(lstatSync).toHaveBeenCalledWith(nativeProgram);
    expect(existsSync).not.toHaveBeenCalledWith(shim);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects a reparse/junction Kimi parent before any side effect", () => {
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
    ).toThrow(/native executable is required/);
    expect(lstatSync).toHaveBeenCalledWith(paths.root);
    expect(lstatSync).not.toHaveBeenCalledWith(paths.bin);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("rejects a final Kimi executable symlink before any side effect", () => {
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
    ).toThrow(/native executable is required/);
    expect(lstatSync).toHaveBeenCalledWith(paths.root);
    expect(lstatSync).toHaveBeenCalledWith(paths.bin);
    expect(lstatSync).toHaveBeenCalledWith(paths.executable);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });

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

  it("adds the real Claude MCP permission transport without leaking its token", async () => {
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
      ["grok-4-6", "plan", "--permission-mode plan", "--always-approve"],
      ["composer-2-5", "plan", "--plan", "--trust"],
      [
        "qwen-3-8-max",
        "bypass",
        "--approval-mode yolo",
        "--approval-mode plan",
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

  it("wires Grok reasoning effort and reports no fake fast tier", () => {
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
  });

  it("rejects a Grok route above the fully quoted Windows argv limit", () => {
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
  });

  it("routes a newly discovered xAI model with its exact native id", () => {
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
  });

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
    expect(route.args).toContain("--safe-mode");
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
    expect(route.args.slice(0, 5)).toEqual([
      "--model",
      "qwen3.8-max",
      "--safe-mode",
      "--prompt",
      "Follow the Cukii broker instructions supplied on stdin.",
    ]);
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
      path.join(__dirname, "bridgeChatAdapter.ts"),
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
      path.join(__dirname, "bridgeChatAdapter.ts"),
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
      .readFileSync(path.join(__dirname, "bridgeChatAdapter.ts"), "utf8")
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
      .readFileSync(path.join(__dirname, "bridgeChatAdapter.ts"), "utf8")
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
});
