import * as fs from "fs";
import { describe, expect, it } from "vitest";

import {
  listBrokerVendorAccounts,
  localKimiServerIdentity,
  nativeCliCandidates,
} from "./bridgeVendorAuth";

const liveIt = process.env.CUKII_LIVE_AUTH_PROBE === "1" ? it : it.skip;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

function redactedIdentity(label: string | undefined): string | undefined {
  if (!label) return undefined;
  return EMAIL.test(label)
    ? `<redacted>@${label.slice(label.lastIndexOf("@") + 1)}`
    : "<provider-profile>";
}

describe("live broker vendor account probe", () => {
  liveIt(
    "obtains Kimi identity through its official child-owned local server",
    async () => {
      const executable = nativeCliCandidates("kimi").find((candidate) =>
        fs.existsSync(candidate),
      );
      expect(executable).toBeTruthy();
      const identity = await localKimiServerIdentity({
        executable,
        cacheKey: `live-child:${Date.now()}`,
      });
      console.info(
        "LIVE_KIMI_CHILD_IDENTITY_REDACTED=" + redactedIdentity(identity),
      );
      expect(identity).toBeTruthy();
      expect(identity).not.toBe("Connected");
      expect(identity).not.toBe("Not logged in");
    },
    30_000,
  );

  liveIt(
    "reports the current Codex identity and truthful Kimi OAuth state",
    async () => {
      const accounts = await listBrokerVendorAccounts();
      const codex = accounts.find((account) => account.id === "codex");
      const kimi = accounts.find((account) => account.id === "kimi");
      const qwen = accounts.find((account) => account.id === "qwen");

      // Never log the local part, bearer material, raw native output, or claims.
      console.info(
        "LIVE_BROKER_AUTH_REDACTED=" +
          JSON.stringify({
            codex: codex && {
              state: codex.state,
              authenticated: codex.authenticated,
              accountLabel: redactedIdentity(codex.accountLabel),
            },
            kimi: kimi && {
              state: kimi.state,
              authenticated: kimi.authenticated,
              accountLabel: redactedIdentity(kimi.accountLabel),
            },
            qwen: qwen && {
              state: qwen.state,
              authenticated: qwen.authenticated,
              accountLabel: redactedIdentity(qwen.accountLabel),
            },
          }),
      );

      expect(codex?.installed).toBe(true);
      expect(codex?.authenticated).toBe(true);
      expect(codex?.state).toBe("connected");
      expect(EMAIL.test(codex?.accountLabel ?? "")).toBe(true);

      expect(kimi?.installed).toBe(true);
      expect(kimi?.authenticated).toBe(true);
      expect(kimi?.state).toBe("connected");
      expect(kimi?.accountLabel).toBeTruthy();
      expect(kimi?.accountLabel).not.toBe("Connected");
      expect(kimi?.accountLabel).not.toBe("Not logged in");
      expect(kimi?.actions).toEqual(["logout"]);

      expect(qwen?.installed).toBe(true);
      expect(qwen?.authenticated).toBe(true);
      expect(qwen?.state).toBe("connected");
      expect(EMAIL.test(qwen?.accountLabel ?? "")).toBe(true);
      expect(qwen?.accountLabel).not.toBe("Connected");
      expect(qwen?.actions).toEqual(["logout"]);
    },
    30_000,
  );
});
