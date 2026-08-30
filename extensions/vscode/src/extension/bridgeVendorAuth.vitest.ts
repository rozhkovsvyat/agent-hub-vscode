import { describe, expect, it } from "vitest";

import {
  accountLabelFromAuthMetadata,
  nativeCliCandidates,
  probeSpec,
  notInstalledVendorStatus,
  notSupportedVendorStatus,
  classifyVendorAuthOutput,
  isMissingCliError,
  localKimiCredentials,
  vendorAuthTerminalCommand,
} from "./bridgeVendorAuth";

describe("Cukii vendor CLI accounts", () => {
  function jwt(payload: Record<string, unknown>): string {
    return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
  }

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
    ).toMatchObject({
      state: "connected",
      accountLabel: "Logged in • Identity unavailable",
    });
    expect(
      classifyVendorAuthOutput("grok", "You are logged in with grok.com."),
    ).toMatchObject({
      state: "connected",
      accountLabel: "Logged in • Identity unavailable",
    });
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
      accountLabel: "Logged in • Identity unavailable",
      actions: ["logout"],
    });
    expect(
      classifyVendorAuthOutput(
        "qwen",
        '{"security":{"auth":{"selectedType":"qwen-oauth"}}}',
      ).state,
    ).toBe("connected");
  });

  it("uses local native auth metadata for a safe, stable account label", () => {
    expect(
      accountLabelFromAuthMetadata("grok", {
        "https://auth.x.ai::profile": {
          email: "owner@example.com",
        },
      }),
    ).toBe("owner@example.com");
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          {
            access_token:
              "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im93bmVyQGV4YW1wbGUuY29tIn0.signature",
          },
        ],
      }),
    ).toBe("owner@example.com");
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          {
            access_token:
              "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhYmNkZWZnaGlqa2xtbm9wcXJzdHV2In0.signature",
          },
        ],
      }),
    ).toBe("Account abcdefgh…stuv");
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [{ access_token: "not-a-jwt" }],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          {
            access_token:
              "eyJhbGciOiJub25lIn0.eyJlbWFpbCI6Im1hbGZvcm1lZEBleGFtcGxlLnRlc3QifQ.",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          { access_token: jwt({ email: "expired@example.test", exp: 0 }) },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("kimi", {
        credentials: [
          {
            access_token: jwt({
              email: "future@example.test",
              nbf: 4_102_444_800,
            }),
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      accountLabelFromAuthMetadata("codex", {
        tokens: { account_id: "acct_42" },
      }),
    ).toBe("Account acct_42");
  });

  it("skips malformed Kimi credential files and prefers the newest valid one", () => {
    const directory = "C:\\Users\\owner\\.kimi-code\\credentials";
    const credentials = localKimiCredentials(directory, {
      readdirSync: () => ["broken.json", "current.json"],
      statSync: (file) => ({
        isFile: () => true,
        size: 100,
        mtimeMs: file.endsWith("current.json") ? 200 : 100,
      }),
      readFileSync: (file) => {
        if (String(file).endsWith("broken.json")) return "{";
        return JSON.stringify({
          access_token: jwt({ email: "current@example.test" }),
        });
      },
    });

    expect(accountLabelFromAuthMetadata("kimi", { credentials })).toBe(
      "current@example.test",
    );
  });

  it("never derives Grok or Kimi identity from CLI output", () => {
    expect(
      classifyVendorAuthOutput(
        "grok",
        "You are logged in with grok.com as stdout-leak@example.test",
      ).accountLabel,
    ).toBe("Logged in • Identity unavailable");
    expect(
      classifyVendorAuthOutput(
        "kimi",
        "managed:kimi-code source=oauth stdout-leak@example.test",
      ).accountLabel,
    ).toBe("Logged in • Identity unavailable");
  });

  it("discovers Cursor from native Windows product locations before PATH", () => {
    const candidates = nativeCliCandidates(
      "cursor",
      "C:\\Users\\owner",
      "win32",
      { LOCALAPPDATA: "C:\\Users\\owner\\AppData\\Local" },
    );
    expect(candidates.slice(0, 2)).toEqual([
      "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.cmd",
      "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.ps1",
    ]);
    expect(
      nativeCliCandidates("cursor", "C:\\Users\\owner", "win32", {}),
    ).toContain(
      "C:\\Users\\owner\\AppData\\Local\\Programs\\Cursor\\resources\\app\\bin\\agent.exe",
    );
    expect(
      nativeCliCandidates("cursor", "C:\\Users\\owner", "win32", {}),
    ).toContain("C:\\Program Files\\Cursor\\resources\\app\\bin\\agent.exe");
    expect(
      nativeCliCandidates("cursor", "C:\\Users\\owner", "win32", {}),
    ).not.toContain("agent");
    expect(
      probeSpec(
        "cursor",
        "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.ps1",
      ),
    ).toMatchObject({
      program: expect.stringMatching(/powershell\.exe$/i),
      args: expect.arrayContaining([
        "-File",
        "C:\\Users\\owner\\AppData\\Local\\cursor-agent\\agent.ps1",
        "status",
      ]),
    });
  });

  it("uses the required disconnected, unavailable, and identity fallback copy", () => {
    expect(notInstalledVendorStatus("cursor")).toMatchObject({
      installed: false,
      authenticated: false,
      state: "unavailable",
      accountLabel: "Not installed",
      actions: ["install"],
    });
    expect(notSupportedVendorStatus()).toMatchObject({
      id: "deepseek",
      installed: false,
      authenticated: false,
      state: "postponed",
      accountLabel: "Not configured / not yet supported",
      actions: [],
    });
    for (const vendor of [
      "claude",
      "codex",
      "grok",
      "cursor",
      "kimi",
      "qwen",
    ] as const) {
      expect(classifyVendorAuthOutput(vendor, "not logged in")).toMatchObject({
        state: "disconnected",
        authenticated: false,
        accountLabel: "Not signed in",
        actions: ["login"],
      });
    }
    expect(
      classifyVendorAuthOutput("kimi", "managed:kimi-code source=oauth"),
    ).toMatchObject({ accountLabel: "Logged in • Identity unavailable" });
    const labels = [
      classifyVendorAuthOutput("claude", '{"loggedIn":false}').accountLabel,
      classifyVendorAuthOutput("codex", "not logged in").accountLabel,
      classifyVendorAuthOutput("grok", "not logged in").accountLabel,
      classifyVendorAuthOutput("cursor", "not logged in").accountLabel,
      classifyVendorAuthOutput("kimi", "not logged in").accountLabel,
      classifyVendorAuthOutput("qwen", "not logged in").accountLabel,
    ];
    expect(labels).not.toContain("Account connected");
    expect(labels).not.toContain("Not logged in");
    expect(
      classifyVendorAuthOutput("codex", "request timed out"),
    ).toMatchObject({
      state: "unknown",
      authenticated: false,
      accountLabel: "Account status unavailable",
    });
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
    expect(vendorAuthTerminalCommand("qwen", "login")?.command).toBe(
      "qwen /auth",
    );
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
