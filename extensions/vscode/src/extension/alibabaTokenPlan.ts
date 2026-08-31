import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  ALIBABA_CHAT_MODELS,
  ALIBABA_CONSOLE_URL,
  ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT,
  ALIBABA_TOKEN_PLAN_ENV_KEY,
  ALIBABA_TOKEN_PLAN_REGION,
  VENDOR_ACCOUNT_COPY,
  alibabaNativeModelId,
  isAlibabaChatModel,
  isAlibabaNonChatCapability,
} from "core/cukiiAlibabaCatalog";
import type { BrokerVendorAuthAction } from "core/protocol/ideWebview";

export const ALIBABA_SECRET_KEY = "cukii.alibaba.tokenPlanCredential";
const SETTINGS_ENV_KEYS = [
  ALIBABA_TOKEN_PLAN_ENV_KEY,
  "BAILIAN_CODING_PLAN_API_KEY",
  "DASHSCOPE_API_KEY",
  "OPENAI_API_KEY",
] as const;

export type ProtectedSecretStore = {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
};

export type AlibabaAuthHost = {
  openExternal(url: string): PromiseLike<boolean>;
  readClipboard(): PromiseLike<string>;
  promptSecret(): PromiseLike<string | undefined>;
};

type SettingsFileSystem = {
  existsSync(file: string): boolean;
  readFileSync(file: string, encoding: BufferEncoding): string;
  mkdirSync(directory: string, options: { recursive: boolean }): void;
  writeFileSync(file: string, contents: string, encoding: BufferEncoding): void;
};

type StoredAlibabaCredential = {
  credential: string;
  accountLabel?: string;
};

const SAFE_EMAIL =
  /^[a-z0-9.!#$%&'*+/^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

let secretStore: ProtectedSecretStore | undefined;

export function bindAlibabaSecretStore(
  store: ProtectedSecretStore | undefined,
): void {
  secretStore = store;
}

export function alibabaSettingsPath(userHome = os.homedir()): string {
  return path.join(userHome, ".qwen", "settings.json");
}

export function looksLikeAlibabaTokenPlanKey(value: string): boolean {
  const key = value.trim();
  if (key.length < 12 || key.length > 512) return false;
  if (/[\x00-\x1f\x7f\s]/.test(key)) return false;
  return /^sk-(?:sp-)?[A-Za-z0-9._~+/-]+$/.test(key);
}

function safeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  return email.length <= 254 && SAFE_EMAIL.test(email) ? email : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function redactAlibabaSecrets(text: string): string {
  return text
    .replace(/sk-sp-[A-Za-z0-9._~+/-]+/g, "sk-sp-[redacted]")
    .replace(/sk-[A-Za-z0-9._~+/-]{8,}/g, "sk-[redacted]")
    .replace(
      /((?:BAILIAN_(?:TOKEN|CODING)_PLAN_API_KEY|OPENAI_API_KEY|DASHSCOPE_API_KEY)\s*[=:]\s*)([^\s"',}]+)/gi,
      "$1[redacted]",
    )
    .replace(
      /("(?:credential|apiKey|api_key|access_token|token)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(/(Authorization:\s*Bearer\s+)(\S+)/gi, "$1[redacted]");
}

function parseStoredCredential(
  raw: string | undefined,
): StoredAlibabaCredential | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && typeof parsed.credential === "string") {
      if (!looksLikeAlibabaTokenPlanKey(parsed.credential)) return undefined;
      return {
        credential: parsed.credential.trim(),
        accountLabel: safeEmail(parsed.accountLabel),
      };
    }
  } catch {
    // Legacy: a raw key may have been stored without JSON wrapping.
  }
  if (!looksLikeAlibabaTokenPlanKey(raw)) return undefined;
  return { credential: raw.trim() };
}

function serializeStoredCredential(stored: StoredAlibabaCredential): string {
  return JSON.stringify({
    credential: stored.credential,
    ...(stored.accountLabel ? { accountLabel: stored.accountLabel } : {}),
  });
}

function readSettings(
  file: string,
  fileSystem: SettingsFileSystem,
): Record<string, unknown> {
  if (!fileSystem.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSettings(
  file: string,
  settings: Record<string, unknown>,
  fileSystem: SettingsFileSystem,
): void {
  fileSystem.mkdirSync(path.dirname(file), { recursive: true });
  fileSystem.writeFileSync(
    file,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

function envRecord(settings: Record<string, unknown>): Record<string, unknown> {
  return isRecord(settings.env) ? settings.env : {};
}

function plaintextSettingsKey(
  settings: Record<string, unknown>,
): string | undefined {
  const env = envRecord(settings);
  for (const key of SETTINGS_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && looksLikeAlibabaTokenPlanKey(value)) {
      return value.trim();
    }
  }
  return undefined;
}

function settingsEmail(settings: Record<string, unknown>): string | undefined {
  return (
    safeEmail(settings.email) ??
    safeEmail(isRecord(settings.account) ? settings.account.email : undefined)
  );
}

export function stripAlibabaCredentialConfig(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...settings };
  const env = { ...envRecord(settings) };
  for (const key of SETTINGS_ENV_KEYS) delete env[key];
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;

  delete next.tokenPlan;
  delete next.codingPlan;

  const providers = isRecord(next.modelProviders)
    ? next.modelProviders
    : undefined;
  const openai = Array.isArray(providers?.openai)
    ? providers.openai
    : undefined;
  if (openai) {
    const retained = openai.filter((entry) => {
      if (!isRecord(entry)) return true;
      const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl : "";
      const envKey = typeof entry.envKey === "string" ? entry.envKey : "";
      return (
        !baseUrl.includes("token-plan.") &&
        !baseUrl.includes("coding-intl.dashscope") &&
        !baseUrl.includes("coding.dashscope") &&
        envKey !== ALIBABA_TOKEN_PLAN_ENV_KEY &&
        envKey !== "BAILIAN_CODING_PLAN_API_KEY"
      );
    });
    const nextProviders = { ...providers };
    if (retained.length > 0) nextProviders.openai = retained;
    else delete nextProviders.openai;
    if (Object.keys(nextProviders).length > 0)
      next.modelProviders = nextProviders;
    else delete next.modelProviders;
  }

  const security = isRecord(next.security) ? { ...next.security } : undefined;
  const auth =
    security && isRecord(security.auth) ? { ...security.auth } : undefined;
  if (
    auth &&
    (auth.selectedType === "openai" || auth.selectedType === "token-plan")
  ) {
    delete auth.selectedType;
  }
  if (auth && Object.keys(auth).length > 0) {
    next.security = { ...security, auth };
  } else if (security) {
    const { auth: _auth, ...restSecurity } = security;
    if (Object.keys(restSecurity).length > 0) next.security = restSecurity;
    else delete next.security;
  }
  return next;
}

export function tokenPlanSettingsWithoutSecrets(
  existing: Record<string, unknown> = {},
): Record<string, unknown> {
  const cleaned = stripAlibabaCredentialConfig(existing);
  const retainedProviders = isRecord(cleaned.modelProviders)
    ? cleaned.modelProviders
    : {};
  const retainedOpenai = Array.isArray(retainedProviders.openai)
    ? retainedProviders.openai
    : [];
  const openai = [
    ...ALIBABA_CHAT_MODELS.map((model) => ({
      id: model.nativeId,
      name: model.label,
      baseUrl: ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT,
      envKey: ALIBABA_TOKEN_PLAN_ENV_KEY,
    })),
    ...retainedOpenai,
  ];
  return {
    ...cleaned,
    modelProviders: {
      ...retainedProviders,
      openai,
    },
    security: {
      ...(isRecord(cleaned.security) ? cleaned.security : {}),
      auth: { selectedType: "openai" },
    },
    tokenPlan: { region: ALIBABA_TOKEN_PLAN_REGION },
    model: { name: ALIBABA_CHAT_MODELS[0]?.nativeId },
  };
}

export async function readAlibabaCredential(
  store: ProtectedSecretStore | undefined = secretStore,
): Promise<StoredAlibabaCredential | undefined> {
  if (!store) return undefined;
  return parseStoredCredential(await store.get(ALIBABA_SECRET_KEY));
}

export async function storeAlibabaCredential(
  credential: string,
  accountLabel?: string,
  store: ProtectedSecretStore | undefined = secretStore,
): Promise<void> {
  if (!store) {
    throw new Error("Alibaba credential store is unavailable.");
  }
  if (!looksLikeAlibabaTokenPlanKey(credential)) {
    throw new Error("Alibaba credential was rejected.");
  }
  await store.store(
    ALIBABA_SECRET_KEY,
    serializeStoredCredential({
      credential: credential.trim(),
      accountLabel: safeEmail(accountLabel),
    }),
  );
}

export async function clearAlibabaCredential(
  store: ProtectedSecretStore | undefined = secretStore,
): Promise<void> {
  if (!store) return;
  await store.delete(ALIBABA_SECRET_KEY);
}

export async function migratePlaintextAlibabaSettings(
  options: {
    userHome?: string;
    fileSystem?: SettingsFileSystem;
    store?: ProtectedSecretStore;
  } = {},
): Promise<boolean> {
  const store = options.store ?? secretStore;
  const fileSystem = options.fileSystem ?? fs;
  const settingsFile = alibabaSettingsPath(options.userHome);
  const settings = readSettings(settingsFile, fileSystem);
  const plaintext = plaintextSettingsKey(settings);
  if (!plaintext || !store) return false;
  const existing = await readAlibabaCredential(store);
  const email = settingsEmail(settings);
  const sameCredential = existing?.credential === plaintext;
  const accountLabel =
    email ?? (sameCredential ? existing?.accountLabel : undefined);
  if (!existing || !sameCredential || existing.accountLabel !== accountLabel) {
    await storeAlibabaCredential(plaintext, accountLabel, store);
  }
  // Import into VS Code SecretStorage without mutating Qwen Code's own
  // working configuration. Manage Accounts is an observer here: opening it
  // must never break the standalone `qwen` CLI. An explicit Log out is the
  // only action allowed to remove the provider configuration.
  return true;
}

export async function alibabaIdentity(
  options: {
    userHome?: string;
    fileSystem?: SettingsFileSystem;
    store?: ProtectedSecretStore;
  } = {},
): Promise<{ authenticated: boolean; accountLabel: string }> {
  const fileSystem = options.fileSystem ?? fs;
  const settings = readSettings(
    alibabaSettingsPath(options.userHome),
    fileSystem,
  );
  const configuredCredential = plaintextSettingsKey(settings);
  await migratePlaintextAlibabaSettings(options);
  const stored = await readAlibabaCredential(options.store ?? secretStore);
  if (!stored && !configuredCredential) {
    return {
      authenticated: false,
      accountLabel: VENDOR_ACCOUNT_COPY.disconnected,
    };
  }
  return {
    authenticated: true,
    accountLabel:
      stored?.accountLabel ??
      settingsEmail(settings) ??
      VENDOR_ACCOUNT_COPY.connectedFallback,
  };
}

export async function alibabaSpawnEnv(
  model: string,
  options: { store?: ProtectedSecretStore } = {},
): Promise<NodeJS.ProcessEnv> {
  if (isAlibabaNonChatCapability(model)) {
    throw new Error(`${model} is Coming soon`);
  }
  if (!isAlibabaChatModel(model) && !model.startsWith("qwen")) {
    return {};
  }
  const native = alibabaNativeModelId(model);
  if (!native) return {};
  const stored = await readAlibabaCredential(options.store ?? secretStore);
  if (!stored) return {};
  return {
    [ALIBABA_TOKEN_PLAN_ENV_KEY]: stored.credential,
    OPENAI_API_KEY: stored.credential,
    OPENAI_BASE_URL: ALIBABA_TOKEN_PLAN_COMPATIBLE_ENDPOINT,
    OPENAI_MODEL: native,
  };
}

export function alibabaQwenArgv(model: string): string[] {
  const native = alibabaNativeModelId(model);
  if (!native) {
    throw new Error(`${model} is Coming soon`);
  }
  return ["--model", native];
}

function collectCredential(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.trim();
  return looksLikeAlibabaTokenPlanKey(key) ? key : undefined;
}

export async function loginAlibabaTokenPlan(options: {
  host: AlibabaAuthHost;
  userHome?: string;
  fileSystem?: SettingsFileSystem;
  store?: ProtectedSecretStore;
}): Promise<{ opened: boolean; message: string }> {
  const store = options.store ?? secretStore;
  await options.host.openExternal(ALIBABA_CONSOLE_URL);
  const fromClipboard = collectCredential(await options.host.readClipboard());
  const credential =
    fromClipboard ?? collectCredential(await options.host.promptSecret());
  if (!credential) {
    return {
      opened: true,
      message: "Authentication flow opened in the integrated terminal.",
    };
  }
  const fileSystem = options.fileSystem ?? fs;
  const settingsFile = alibabaSettingsPath(options.userHome);
  const existing = readSettings(settingsFile, fileSystem);
  await storeAlibabaCredential(credential, settingsEmail(existing), store);
  writeSettings(
    settingsFile,
    tokenPlanSettingsWithoutSecrets(existing),
    fileSystem,
  );
  return {
    opened: true,
    message: "Authentication flow opened in the integrated terminal.",
  };
}

export async function logoutAlibabaTokenPlan(
  options: {
    userHome?: string;
    fileSystem?: SettingsFileSystem;
    store?: ProtectedSecretStore;
  } = {},
): Promise<{ opened: boolean; message: string }> {
  await clearAlibabaCredential(options.store ?? secretStore);
  const fileSystem = options.fileSystem ?? fs;
  const settingsFile = alibabaSettingsPath(options.userHome);
  if (fileSystem.existsSync(settingsFile)) {
    const existing = readSettings(settingsFile, fileSystem);
    writeSettings(
      settingsFile,
      stripAlibabaCredentialConfig(existing),
      fileSystem,
    );
  }
  return {
    opened: true,
    message: "Authentication flow opened in the integrated terminal.",
  };
}

export async function runAlibabaAuthAction(
  action: BrokerVendorAuthAction,
  options: {
    host: AlibabaAuthHost;
    userHome?: string;
    fileSystem?: SettingsFileSystem;
    store?: ProtectedSecretStore;
  },
): Promise<{ opened: boolean; message: string } | undefined> {
  if (action === "login") return loginAlibabaTokenPlan(options);
  if (action === "logout") {
    return logoutAlibabaTokenPlan({
      userHome: options.userHome,
      fileSystem: options.fileSystem,
      store: options.store,
    });
  }
  return undefined;
}

export function settingsContainAlibabaSecret(
  settings: Record<string, unknown>,
): boolean {
  return plaintextSettingsKey(settings) !== undefined;
}
