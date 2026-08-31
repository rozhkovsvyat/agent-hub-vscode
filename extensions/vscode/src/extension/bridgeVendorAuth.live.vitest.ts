import { describe, expect, it } from "vitest";

import { listBrokerVendorAccounts } from "./bridgeVendorAuth";

const liveIt = process.env.CUKII_LIVE_AUTH_PROBE === "1" ? it : it.skip;
const EMAIL = /^[^@\s]+@[^@\s]+$/;

function redactedIdentity(label: string): string {
  return EMAIL.test(label)
    ? `<redacted>@${label.slice(label.lastIndexOf("@") + 1)}`
    : label;
}

describe("live broker vendor account probe", () => {
  liveIt(
    "reports the current Codex identity and truthful Kimi OAuth state",
    async () => {
      const accounts = await listBrokerVendorAccounts();
      const codex = accounts.find((account) => account.id === "codex");
      const kimi = accounts.find((account) => account.id === "kimi");

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
          }),
      );

      expect(codex?.installed).toBe(true);
      expect(codex?.authenticated).toBe(true);
      expect(codex?.state).toBe("connected");
      expect(EMAIL.test(codex?.accountLabel ?? "")).toBe(true);

      expect(kimi?.installed).toBe(true);
      expect(kimi?.authenticated).toBe(true);
      expect(kimi?.state).toBe("connected");
      expect(kimi?.accountLabel).not.toBe("Not logged in");
      expect(
        kimi?.accountLabel === "Connected" ||
          EMAIL.test(kimi?.accountLabel ?? ""),
      ).toBe(true);
    },
    30_000,
  );
});
