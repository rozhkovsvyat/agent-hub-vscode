import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeCanaryAttestation,
  runtimeCanaryExtensionBinding,
  runtimeCanaryResponseSummary,
  runtimeCanaryResult,
  runtimeCanaryTurn,
} from "./runtimeCanaryAttestation";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime canary local attestation", () => {
  it("emits only extension-to-webview events; ui_submit belongs to the local controller", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-canary-"));
    temporaryDirectories.push(directory);
    fs.writeFileSync(
      path.join(directory, "package.json"),
      '{"version":"2.0.68"}',
    );
    const turn = runtimeCanaryTurn([
      {
        role: "user",
        content:
          "[[CUKII_RUNTIME_CANARY turn_id=turn_1234567890 nonce=nonce_1234567890123456]] reply with OK",
      },
    ]);
    const extension = runtimeCanaryExtensionBinding(directory, "2.0.68");
    const events: object[] = [];
    const attestation = new RuntimeCanaryAttestation(
      turn!,
      "kimi-k3",
      extension!,
      (event) => events.push(event),
    );

    attestation.record("bridge_dispatch");
    attestation.record("vendor_completed", {
      result: "completed",
      exit_code: 0,
      ...runtimeCanaryResponseSummary("CUKII_CANARY_OK"),
    });

    expect(events).toHaveLength(2);
    expect(events.map((event: any) => event.event)).toEqual([
      "bridge_dispatch",
      "vendor_completed",
    ]);
    expect(events.map((event: any) => event.seq)).toEqual([1, 2]);
    expect(
      events.every((event: any) => event.extension_root === directory),
    ).toBe(true);
  });

  it("does not mint a canary from ordinary or malformed turns", () => {
    expect(
      runtimeCanaryTurn([{ role: "user", content: "hello" }]),
    ).toBeUndefined();
    expect(
      runtimeCanaryTurn([
        { role: "user", content: "[[CUKII_RUNTIME_CANARY turn_id=x nonce=y]]" },
      ]),
    ).toBeUndefined();
  });

  it("keeps quota blocked and binds the terminal response digest", () => {
    expect(runtimeCanaryResult(1, "", "provider quota exhausted")).toBe(
      "provider_quota",
    );
    expect(runtimeCanaryResponseSummary("CUKII_CANARY_OK")).toEqual({
      response_sha256:
        "92f77db5e5075402e5b1616ddb515c7e6d45ff63d91e44ed14213d8e162f23be",
      response_length: 15,
    });
  });
});
