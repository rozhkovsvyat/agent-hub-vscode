import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProtectedSecretStore } from "./alibabaTokenPlan";
import {
  CUKII_MEMORY_SECRET_KEY,
  CukiiMemoryAccountController,
  normalizeMemoryEndpoint,
  probeCukiiMemory,
} from "./cukiiMemoryAccount";

class MemoryStore implements ProtectedSecretStore {
  readonly values = new Map<string, string>();
  get(key: string) {
    return Promise.resolve(this.values.get(key));
  }
  store(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function extensionRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cukii-memory-account-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "out"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "out", "cukiiMemoryProxy.js"),
    "// fixture\n",
  );
  return root;
}

describe("Cukii Box account", () => {
  it("normalizes only HTTPS or loopback MCP endpoints", () => {
    expect(normalizeMemoryEndpoint("https://box.example.test")).toBe(
      "https://box.example.test/mcp",
    );
    expect(normalizeMemoryEndpoint("http://127.0.0.1:8780/mcp")).toBe(
      "http://127.0.0.1:8780/mcp",
    );
    expect(() =>
      normalizeMemoryEndpoint("http://box.example.test/mcp"),
    ).toThrow(/HTTPS/);
  });

  it("requires both healthz and authenticated MCP initialize", async () => {
    const httpFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return new Response('{"ok":true}');
        expect(init?.headers).toMatchObject({
          authorization: `Bearer ${"t".repeat(32)}`,
        });
        return new Response(
          JSON.stringify({ result: { serverInfo: { name: "cukii-memory" } } }),
        );
      },
    ) as typeof fetch;

    await probeCukiiMemory(
      { endpoint: "https://box.example.test/mcp", token: "t".repeat(32) },
      httpFetch,
    );
    expect(httpFetch).toHaveBeenCalledTimes(2);
  });

  it("stores the remote bearer only in SecretStorage and gives vendors a loopback capability", async () => {
    const store = new MemoryStore();
    const descriptors: unknown[] = [];
    const boxToken = "box-secret-" + "x".repeat(40);
    const httpFetch = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/healthz")) return new Response('{"ok":true}');
        const authorization = (
          init?.headers as Record<string, string> | undefined
        )?.authorization;
        expect(authorization).toBe(`Bearer ${boxToken}`);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { serverInfo: { name: "cukii-memory" } },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    ) as typeof fetch;
    const controller = new CukiiMemoryAccountController(
      store,
      extensionRoot(),
      process.execPath,
      httpFetch,
      {
        ensure: (_vendor, descriptor) => {
          descriptors.push(descriptor);
          return true;
        },
        remove: vi.fn(),
      },
    );

    const result = await controller.runAction("login", {
      promptEndpoint: async () => "https://box.example.test/mcp",
      promptToken: async () => boxToken,
    });
    expect(result.message).toContain("6 vendor CLIs");
    expect(store.values.get(CUKII_MEMORY_SECRET_KEY)).toContain(boxToken);
    expect(JSON.stringify(descriptors)).not.toContain(boxToken);
    const descriptor = descriptors[0] as {
      url: string;
      capability: string;
    };
    expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(descriptor.capability).toHaveLength(43);

    const relayed = await fetch(descriptor.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${descriptor.capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    expect(relayed.status).toBe(200);
    expect(await relayed.json()).toMatchObject({
      result: { serverInfo: { name: "cukii-memory" } },
    });
    controller.dispose();
  });

  it("fails closed on the loopback relay capability but leaves chat integration fail-open", async () => {
    const store = new MemoryStore();
    const controller = new CukiiMemoryAccountController(
      store,
      extensionRoot(),
      process.execPath,
      vi.fn() as unknown as typeof fetch,
      { ensure: vi.fn(() => true), remove: vi.fn() },
    );
    expect(await controller.ensureForModel("gpt-5.6-sol")).toBe(false);
    expect(await controller.status()).toMatchObject({
      id: "memory",
      group: "memory",
      state: "disconnected",
      actions: ["login"],
    });
  });
});
