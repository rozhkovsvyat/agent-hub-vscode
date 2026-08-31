import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
          : ["plan", "bypass"],
    helpSource: "test-route",
  }),
}));

import {
  attachClaudePermissionTransport,
  claudeStreamingInput,
  KIMI_WINDOWS_CREATEPROCESS_SAFE_UTF16,
  nativeDelegateHint,
  nativePromptCacheArgs,
  routeForModel,
  toChatMessages,
  windowsCommandLineUtf16Length,
} from "./bridgeChatAdapter";
import { ClaudePermissionBroker } from "./claudePermissionBroker";
import { resolveBridgeControls } from "./bridgeControls";
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

  it("rejects 24,000 quote/backslash characters before Scratch or process launch", () => {
    const writeFileSync = vi.spyOn(fs, "writeFileSync");
    const mkdirSync = vi.spyOn(fs, "mkdirSync");
    const oversized = '\\"'.repeat(12_000);
    expect(() =>
      routeForModel(
        "kimi-k3",
        "D:/Brain/vault",
        oversized,
        [],
        resolveBridgeControls("kimi-k3", "high", "standard"),
      ),
    ).toThrow(/safe CreateProcess limit/);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
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

  it("rejects an unsupported live image before a text-only envelope can be written", () => {
    expect(() =>
      claudeStreamingInput([
        { type: "text", text: "inspect this" },
        { type: "imageUrl", imageUrl: { url: "file:///D:/image.png" } },
      ]),
    ).toThrow(/only data-URL image attachments/i);
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

  it.each([
    ["opus-5", true],
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
        model.startsWith("codex") ? "bypass" : "manual",
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

  it("routes Qwen through the exact released native model id", () => {
    const route = routeForModel(
      "qwen-3-8-max",
      "D:/Brain/vault",
      "prompt",
      [],
      resolveBridgeControls("qwen-3-8-max", "high", "standard"),
    );
    if (route.promptFile) promptFiles.push(route.promptFile);
    expect(route.program).toBe("qwen");
    expect(route.args[route.args.indexOf("--model") + 1]).toBe("qwen3.8-max");
    expect(route.args.join(" ")).not.toContain("preview");

    const hint = nativeDelegateHint("qwen-3-8-max", "D:/Brain/vault", "plan");
    expect(hint).toContain("qwen --model qwen3.8-max --prompt");
    expect(hint).not.toContain("preview");
  });

  it("keeps the obsolete Qwen preview model id out of production sources", () => {
    const productionSources = (directory: string): string[] =>
      fs
        .readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) return productionSources(fullPath);
          return entry.isFile() &&
            entry.name.endsWith(".ts") &&
            !entry.name.endsWith(".vitest.ts")
            ? [fullPath]
            : [];
        });
    const sources = productionSources(path.join(__dirname, "..", ".."));
    expect(sources).not.toEqual([]);
    for (const file of sources) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(
        "qwen3.8-max-preview",
      );
    }
  });
});
