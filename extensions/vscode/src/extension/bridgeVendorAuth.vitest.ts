import { describe, expect, it } from "vitest";

import {
  classifyVendorAuthOutput,
  isMissingCliError,
  vendorAuthTerminalCommand,
} from "./bridgeVendorAuth";

describe("Cukii vendor CLI accounts", () => {
  it("classifies real CLI status shapes without a decorative local flag", () => {
    expect(
      classifyVendorAuthOutput(
        "claude",
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "owner@example.com",
        }),
      ),
    ).toMatchObject({
      state: "connected",
      accountLabel: "owner@example.com",
      actions: ["logout"],
    });
    expect(
      classifyVendorAuthOutput("codex", "Logged in using ChatGPT"),
    ).toMatchObject({ state: "connected", accountLabel: "Account connected" });
    expect(
      classifyVendorAuthOutput("grok", "You are logged in with grok.com."),
    ).toMatchObject({ state: "connected", accountLabel: "Account connected" });
    expect(
      classifyVendorAuthOutput(
        "cursor",
        JSON.stringify({
          isAuthenticated: true,
          userInfo: { email: "owner@example.com" },
        }),
      ),
    ).toMatchObject({
      state: "connected",
      accountLabel: "owner@example.com",
    });
    expect(
      classifyVendorAuthOutput("kimi", "managed:kimi-code source=oauth"),
    ).toMatchObject({
      accountLabel: "Account connected",
      actions: ["logout"],
    });
    expect(
      classifyVendorAuthOutput(
        "qwen",
        '{"security":{"auth":{"selectedType":"qwen-oauth"}}}',
      ).state,
    ).toBe("connected");
  });

  it("uses only supported native login/logout flows", () => {
    expect(vendorAuthTerminalCommand("claude", "logout")?.command).toBe(
      "claude auth logout",
    );
    expect(vendorAuthTerminalCommand("codex", "login")?.command).toBe(
      "codex login --device-auth",
    );
    expect(vendorAuthTerminalCommand("cursor", "login")?.command).toContain(
      "agent login",
    );
    expect(vendorAuthTerminalCommand("kimi", "logout")).toMatchObject({
      command: "kimi",
      followup: "/logout",
    });
    expect(vendorAuthTerminalCommand("qwen", "logout")).toBeUndefined();
    expect(vendorAuthTerminalCommand("deepseek", "login")).toBeUndefined();
  });

  it("installs the latest official native CLI package", () => {
    expect(vendorAuthTerminalCommand("claude", "install")?.command).toBe(
      "npm install -g @anthropic-ai/claude-code@latest",
    );
    expect(vendorAuthTerminalCommand("codex", "install")?.command).toBe(
      "npm install -g @openai/codex@latest",
    );
    expect(vendorAuthTerminalCommand("grok", "install")?.command).toBe(
      "npm install -g @xai-official/grok@latest",
    );
    expect(vendorAuthTerminalCommand("kimi", "install")?.command).toBe(
      "npm install -g @moonshot-ai/kimi-code@latest",
    );
    expect(vendorAuthTerminalCommand("qwen", "install")?.command).toBe(
      "npm install -g @qwen-code/qwen-code@latest",
    );
    expect(vendorAuthTerminalCommand("cursor", "install")?.command).toContain(
      "https://cursor.com/install?win32=true",
    );
  });

  it("detects missing executables from native Windows and WSL failures", () => {
    expect(
      isMissingCliError({
        stderr: "'qwen' is not recognized as an internal or external command",
      }),
    ).toBe(true);
    expect(
      isMissingCliError({ stderr: "bash: cursor-agent: command not found" }),
    ).toBe(true);
    expect(isMissingCliError(new Error("authentication expired"))).toBe(false);
  });
});
