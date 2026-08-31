import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ALIBABA_CHAT_MODELS,
  ALIBABA_CONSOLE_URL,
  ALIBABA_NON_CHAT_CAPABILITIES,
  ALIBABA_TOKEN_PLAN_ANTHROPIC_ENDPOINT,
  ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT,
  ALIBABA_TOKEN_PLAN_ENV_KEY,
  VENDOR_ACCOUNT_COPY,
} from "core/cukiiAlibabaCatalog";
import {
  ALIBABA_SECRET_KEY,
  alibabaIdentity,
  alibabaQwenArgv,
  alibabaSettingsPath,
  alibabaSpawnEnv,
  bindAlibabaSecretStore,
  clearAlibabaCredential,
  loginAlibabaTokenPlan,
  logoutAlibabaTokenPlan,
  looksLikeAlibabaTokenPlanKey,
  migratePlaintextAlibabaSettings,
  redactAlibabaSecrets,
  settingsContainAlibabaSecret,
  storeAlibabaCredential,
  stripAlibabaCredentialConfig,
  tokenPlanSettingsWithoutSecrets,
  type ProtectedSecretStore,
} from "./alibabaTokenPlan";

function memoryStore(
  initial: Record<string, string> = {},
): ProtectedSecretStore {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) {
      return values.get(key);
    },
    async store(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cukii-alibaba-"));
}

describe("Alibaba Token Plan credentials", () => {
  it("redacts token-plan secrets from logs and serialized config", () => {
    const leaked = [
      "Bearer sk-sp-super-secret-token-plan-key",
      `${ALIBABA_TOKEN_PLAN_ENV_KEY}=sk-sp-super-secret-token-plan-key`,
      "OPENAI_API_KEY: sk-abcdefghijklmnopqrstuvwxyz",
      '{"credential":"sk-sp-super-secret-token-plan-key","accountLabel":"owner@example.com"}',
    ].join("\n");
    const redacted = redactAlibabaSecrets(leaked);
    expect(redacted).not.toContain("sk-sp-super-secret-token-plan-key");
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toContain("sk-sp-[redacted]");
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("owner@example.com");
  });

  it("accepts Token Plan keys and rejects identity-shaped noise", () => {
    expect(looksLikeAlibabaTokenPlanKey("sk-sp-team-coding-plan")).toBe(true);
    expect(looksLikeAlibabaTokenPlanKey("sk-abcdefghijklmnopqrstuvwxyz")).toBe(
      true,
    );
    expect(looksLikeAlibabaTokenPlanKey("owner@example.com")).toBe(false);
    expect(looksLikeAlibabaTokenPlanKey("qwen3.8-max")).toBe(false);
  });

  it("keeps generated settings secret-free and imports an existing CLI login without breaking it", async () => {
    const home = tempHome();
    const store = memoryStore();
    bindAlibabaSecretStore(store);
    try {
      const existing = {
        mcpServers: { memory: { command: "npx" } },
        env: { [ALIBABA_TOKEN_PLAN_ENV_KEY]: "sk-sp-should-not-remain" },
        email: "owner@example.com",
      };
      const next = tokenPlanSettingsWithoutSecrets(existing);
      expect(settingsContainAlibabaSecret(next)).toBe(false);
      expect(JSON.stringify(next)).not.toContain("sk-sp-");
      expect(next.mcpServers).toEqual(existing.mcpServers);
      expect(next.tokenPlan).toEqual({ region: "ap-southeast-1" });
      expect(
        (next.security as { auth?: { selectedType?: string } }).auth
          ?.selectedType,
      ).toBe("openai");

      fs.mkdirSync(path.join(home, ".qwen"), { recursive: true });
      fs.writeFileSync(
        alibabaSettingsPath(home),
        JSON.stringify(existing),
        "utf8",
      );
      await migratePlaintextAlibabaSettings({ userHome: home, store });
      const migrated = JSON.parse(
        fs.readFileSync(alibabaSettingsPath(home), "utf8"),
      ) as Record<string, unknown>;
      expect(settingsContainAlibabaSecret(migrated)).toBe(true);
      expect(JSON.stringify(migrated)).toContain("sk-sp-should-not-remain");
      expect(migrated).toEqual(existing);
      const identity = await alibabaIdentity({ userHome: home, store });
      expect(identity).toEqual({
        authenticated: true,
        accountLabel: "owner@example.com",
      });
      const stored = (await store.get(ALIBABA_SECRET_KEY)) ?? "";
      expect(stored).toContain("sk-sp-should-not-remain");
      expect(redactAlibabaSecrets(stored)).not.toContain(
        "sk-sp-should-not-remain",
      );
    } finally {
      bindAlibabaSecretStore(undefined);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("imports from the official console clipboard and logs out only Alibaba config", async () => {
    const home = tempHome();
    const store = memoryStore();
    const settingsFile = alibabaSettingsPath(home);
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        mcpServers: { memory: { command: "npx" } },
        hooks: { Stop: [] },
      }),
      "utf8",
    );
    const opened: string[] = [];
    await loginAlibabaTokenPlan({
      host: {
        async openExternal(url) {
          opened.push(url);
          return true;
        },
        async readClipboard() {
          return "sk-sp-imported-from-alibaba-console";
        },
        async promptSecret() {
          throw new Error("Manage Accounts must not collect a key field");
        },
      },
      userHome: home,
      store,
    });
    expect(opened).toEqual([ALIBABA_CONSOLE_URL]);
    const afterLogin = JSON.parse(
      fs.readFileSync(settingsFile, "utf8"),
    ) as Record<string, unknown>;
    expect(settingsContainAlibabaSecret(afterLogin)).toBe(false);
    expect(JSON.stringify(afterLogin)).not.toContain("sk-sp-imported");
    expect(afterLogin.mcpServers).toEqual({ memory: { command: "npx" } });
    expect(await alibabaIdentity({ userHome: home, store })).toEqual({
      authenticated: true,
      accountLabel: "Connected",
    });

    await logoutAlibabaTokenPlan({ userHome: home, store });
    const afterLogout = JSON.parse(
      fs.readFileSync(settingsFile, "utf8"),
    ) as Record<string, unknown>;
    expect(afterLogout.mcpServers).toEqual({ memory: { command: "npx" } });
    expect(afterLogout.hooks).toEqual({ Stop: [] });
    expect(afterLogout.tokenPlan).toBeUndefined();
    expect(afterLogout.modelProviders).toBeUndefined();
    expect(await alibabaIdentity({ userHome: home, store })).toEqual({
      authenticated: false,
      accountLabel: VENDOR_ACCOUNT_COPY.disconnected,
    });
    expect(await store.get(ALIBABA_SECRET_KEY)).toBeUndefined();
  });

  it("builds the compatible-mode spawn env and refuses fake chat routes", async () => {
    const store = memoryStore();
    await storeAlibabaCredential(
      "sk-sp-spawn-secret-credential",
      undefined,
      store,
    );
    const env = await alibabaSpawnEnv("qwen-3-8-max", { store });
    expect(env.OPENAI_BASE_URL).toBe(ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT);
    expect(env.OPENAI_BASE_URL).not.toBe(ALIBABA_TOKEN_PLAN_ANTHROPIC_ENDPOINT);
    expect(env.OPENAI_MODEL).toBe("qwen3.8-max");
    expect(env[ALIBABA_TOKEN_PLAN_ENV_KEY]).toBe(
      "sk-sp-spawn-secret-credential",
    );
    expect(alibabaQwenArgv("qwen-3-8-max")).toEqual(["--model", "qwen3.8-max"]);
    expect(alibabaQwenArgv("qwen-3-8-max")).not.toContain(
      "qwen3.8-max-preview",
    );
    expect(alibabaQwenArgv("qwen-glm-5-2")).toEqual(["--model", "glm-5.2"]);
    for (const capability of ALIBABA_NON_CHAT_CAPABILITIES) {
      expect(() => alibabaQwenArgv(capability.id)).toThrow("Coming soon");
      await expect(alibabaSpawnEnv(capability.id, { store })).rejects.toThrow(
        "Coming soon",
      );
    }
    expect(
      ALIBABA_CHAT_MODELS.map((model) => alibabaQwenArgv(model.value)),
    ).toEqual(ALIBABA_CHAT_MODELS.map((model) => ["--model", model.nativeId]));
    await clearAlibabaCredential(store);
  });

  it("strips only Alibaba credential fields from mixed Qwen settings", () => {
    const stripped = stripAlibabaCredentialConfig({
      env: {
        [ALIBABA_TOKEN_PLAN_ENV_KEY]: "sk-sp-hidden",
        OTHER: "keep",
      },
      tokenPlan: { region: "ap-southeast-1" },
      codingPlan: { region: "global" },
      modelProviders: {
        openai: [
          {
            id: "qwen3.8-max",
            baseUrl: ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT,
            envKey: ALIBABA_TOKEN_PLAN_ENV_KEY,
          },
          {
            id: "local",
            baseUrl: "http://127.0.0.1:11434/v1",
          },
        ],
      },
      security: { auth: { selectedType: "openai" } },
      mcpServers: { memory: { command: "npx" } },
    });
    expect(JSON.stringify(stripped)).not.toContain("sk-sp-hidden");
    expect(stripped.env).toEqual({ OTHER: "keep" });
    expect(stripped.mcpServers).toEqual({ memory: { command: "npx" } });
    expect(
      (stripped.modelProviders as { openai: Array<{ id: string }> }).openai,
    ).toEqual([{ id: "local", baseUrl: "http://127.0.0.1:11434/v1" }]);
    expect(stripped.tokenPlan).toBeUndefined();
  });
});
