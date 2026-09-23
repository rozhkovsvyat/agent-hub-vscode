import fs from "node:fs";
import path from "node:path";

import type { ChatMessage } from "core";
import { afterEach, describe, expect, it, vi } from "vitest";

// bridgeChatAdapter lives in the installed @cukii/vendor-bridge dependency
// (git, tag v0.1.0); the source contracts below pin its shipped sources.
const VENDOR_BRIDGE_SRC = path.join(
  __dirname,
  "..", "..", "node_modules", "@cukii", "vendor-bridge", "src",
);

vi.mock("vscode", () => ({ workspace: { workspaceFolders: [] } }));
// permissionCapabilities lives in the installed @cukii/vendor-bridge; mock
// the real module id so the mock reaches both the package internals and
// direct importers.
vi.mock("../../node_modules/@cukii/vendor-bridge/src/permissionCapabilities", () => ({
  cachedVendorPermissionCapabilities: (vendor: string) => ({
    vendor,
    supportedModes:
      vendor === "codex"
        ? ["bypass"]
        : vendor === "deepseek"
          ? []
          : ["plan", "bypass"],
    helpSource: "test-kimi-memory-cluster",
  }),
}));

import {
  brokerMemoryDirective,
  nativeResumeIdForModel,
  routeForModel,
} from "@cukii/vendor-bridge";
import { BridgeEventParser } from "@cukii/vendor-bridge";
import { resolveBridgeControls } from "@cukii/vendor-bridge";
import {
  argvRequestsVendorResume,
  isVendorSessionLossError,
  rememberVendorSession,
  resetVendorSessionsForTests,
} from "@cukii/vendor-bridge";

afterEach(() => {
  resetVendorSessionsForTests();
});

const KIMI_RESUME_ID = "session_5eca6961-61ef-4a5a-8a64-a5dea84df021";
const MEMORY_FOOTER =
  "Мало или мимо — спроси память сама: memory_search с формулировкой по сути задачи.";

function kimiRoute(prompt: string, resumeId?: string) {
  return routeForModel(
    "kimi-k3",
    "D:/Brain/vault",
    prompt,
    [],
    resolveBridgeControls("kimi-k3", "high", "standard"),
    "bypass",
    resumeId,
  );
}

describe("kimi memory cluster (511c222a / c2584a34 / 7ffde5c2 / 1c9dd37d)", () => {
  it("captures the live kimi resume_hint as a vendor session id (511c222a)", () => {
    const parser = new BridgeEventParser("kimi-ndjson");
    const events = parser.push(
      JSON.stringify({
        role: "meta",
        type: "session.resume_hint",
        session_id: KIMI_RESUME_ID,
        command: `kimi -r ${KIMI_RESUME_ID}`,
        content: `To resume this session: kimi -r ${KIMI_RESUME_ID}`,
      }) + "\n",
    );
    expect(events).toEqual([{ kind: "vendorSession", id: KIMI_RESUME_ID }]);
    expect(parser.sawStructuredOutput).toBe(true);
  });

  it("resumes a remembered kimi session instead of rebuilding the transcript (511c222a, 1c9dd37d)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "old task with a long transcript" },
      { role: "assistant", content: "working" },
      { role: "user", content: "continue from the stop" },
    ];
    const route = routeForModel(
      "kimi-k3",
      "D:/Brain/vault",
      "continue from the stop",
      messages,
      resolveBridgeControls("kimi-k3", "medium", "standard"),
      "bypass",
      KIMI_RESUME_ID,
    );
    const sessionAt = route.args.indexOf("--session");
    expect(sessionAt).toBeGreaterThan(-1);
    expect(route.args[sessionAt + 1]).toBe(KIMI_RESUME_ID);
    expect(route.args).toContain("-p");
    expect(route.args[route.args.indexOf("-p") + 1]).toBe(
      "continue from the stop",
    );
    expect(route.args.join("\n")).not.toContain("old task with a long transcript");
  });

  it("does not pass --session on a kimi cold start", () => {
    const route = kimiRoute("first turn");
    expect(route.args).not.toContain("--session");
    expect(route.args).not.toContain("-r");
    expect(route.args).not.toContain("-S");
  });

  it("feeds a remembered kimi id into the next native launch (511c222a)", () => {
    rememberVendorSession("cukii-1", "kimi-k3", KIMI_RESUME_ID);
    expect(nativeResumeIdForModel("cukii-1", "kimi-k3")).toBe(KIMI_RESUME_ID);
    expect(nativeResumeIdForModel("cukii-1", "fable-5-1")).toBeUndefined();
    expect(nativeResumeIdForModel("cukii-1", "grok-4-6")).toBeUndefined();
  });

  it("treats kimi --session argv as a resume so a lost native id can cold-start", () => {
    expect(argvRequestsVendorResume(["--resume", "9252c6e5"])).toBe(true);
    expect(argvRequestsVendorResume(["--session", KIMI_RESUME_ID, "-p", "go"])).toBe(
      true,
    );
    expect(argvRequestsVendorResume(["-p", "go", "--output-format", "stream-json"])).toBe(
      false,
    );
  });

  it("recognizes kimi 2.0 session-loss wording (511c222a)", () => {
    expect(
      isVendorSessionLossError(
        `error: failed to run prompt: Session "${KIMI_RESUME_ID}" not found.`,
      ),
    ).toBe(true);
    expect(isVendorSessionLossError("model is at capacity")).toBe(false);
  });

  it("hides the UserPromptSubmit memory dump glued to the first kimi answer (c2584a34)", () => {
    const parser = new BridgeEventParser("kimi-ndjson");
    const events = parser.push(
      JSON.stringify({
        role: "assistant",
        content: `${MEMORY_FOOTER}Привет! Принял задачу.`,
      }) + "\n",
    );
    expect(events).toEqual([
      { kind: "text", text: "Привет! Принял задачу." },
    ]);
  });

  it("drops a kimi assistant frame that is only the memory inject (c2584a34, 1c9dd37d)", () => {
    const parser = new BridgeEventParser("kimi-ndjson");
    expect(
      parser.push(
        JSON.stringify({
          role: "assistant",
          content: `<hook_result hook_event="UserPromptSubmit">\n${MEMORY_FOOTER}\n</hook_result>`,
        }) + "\n",
      ),
    ).toEqual([]);
  });

  it("leaves ordinary kimi assistant text untouched", () => {
    const parser = new BridgeEventParser("kimi-ndjson");
    expect(
      parser.push(
        '{"role":"assistant","content":"There is one file: hello.txt"}\n',
      ),
    ).toEqual([{ kind: "text", text: "There is one file: hello.txt" }]);
  });

  it("does not point kimi --skills-dir at claude/codex skill trees (7ffde5c2)", () => {
    const route = kimiRoute("reply with only K3_CANARY_OK");
    expect(route.args).not.toContain("--skills-dir");
    const joined = route.args.join("\n");
    expect(joined).not.toMatch(/\.claude[/\\]skills/i);
    expect(joined).not.toMatch(/\.codex[/\\]skills/i);
    expect(joined).not.toContain("agent-hub-vscode");
    expect(joined).not.toContain("fm-reboot");
  });

  it("tells kimi to use cukii-memory MCP instead of grepping skill folders (7ffde5c2)", () => {
    const lines = brokerMemoryDirective("kimi-k3");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cukii-memory");
    expect(lines[0]).toMatch(/memory_search/);
    expect(lines[0]).toMatch(/grep/i);
    expect(brokerMemoryDirective("kimi:kimi-code/k4")).toHaveLength(1);
  });

  it("keeps the streamBridgeChat resume gate open for kimi, not only Claude", () => {
    const source = fs
      .readFileSync(path.join(VENDOR_BRIDGE_SRC, "bridgeChatAdapter.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const start = source.indexOf("const vendorResumeId");
    expect(start).toBeGreaterThan(-1);
    const snippet = source.slice(start, source.indexOf(";", start) + 1);
    expect(snippet).toContain("nativeResumeIdForModel");
  });
});
