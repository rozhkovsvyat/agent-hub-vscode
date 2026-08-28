import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";

import {
  ClaudePermissionBroker,
  permissionInputFingerprint,
  type ClaudePermissionRequest,
} from "./claudePermissionBroker";
import {
  PermissionPipeClient,
  requestPermissionOverPipe,
} from "./claudePermissionMcpWorker";

const brokers: ClaudePermissionBroker[] = [];
const rawSockets: net.Socket[] = [];
afterEach(async () => {
  rawSockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(brokers.splice(0).map((broker) => broker.dispose()));
});

async function rawBrokerClient(pipeName: string) {
  const socket = net.createConnection(pipeName);
  rawSockets.push(socket);
  const frames: Record<string, unknown>[] = [];
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let boundary = buffer.indexOf("\n");
    while (boundary >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      boundary = buffer.indexOf("\n");
      if (line.trim()) frames.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, frames };
}

async function brokerFor(
  mode: "manual" | "editAutomatically" | "plan" | "auto" = "manual",
  timeoutMs = 2_000,
) {
  let received: ClaudePermissionRequest | undefined;
  const broker = new ClaudePermissionBroker({
    panelId: "panel-a",
    sessionId: "session-a",
    mode,
    timeoutMs,
    onRequest: (request) => {
      received = request;
    },
  });
  brokers.push(broker);
  await broker.start();
  return {
    broker,
    get received() {
      return received;
    },
  };
}

describe("Claude MCP permission broker", () => {
  it("denies only an oversized frame and continues with auth and permission in the same chunk", async () => {
    const fixture = await brokerFor();
    const client = await rawBrokerClient(fixture.broker.pipeName);
    const request = {
      type: "permission",
      wireRequestId: "after-oversize",
      tool_name: "Bash",
      input: { command: "git status" },
    };
    client.socket.write(
      `${"x".repeat(64 * 1024 + 1)}\n${JSON.stringify({ type: "auth", token: fixture.broker.token, sessionId: "session-a" })}\n${JSON.stringify(request)}\n`,
    );

    await vi.waitFor(() => expect(fixture.received).toBeDefined());
    expect(client.frames).toContainEqual(
      expect.objectContaining({
        type: "permissionResult",
        wireRequestId: "",
        behavior: "deny",
      }),
    );
    fixture.broker.respond({ ...fixture.received!, decision: "allow" });
    await vi.waitFor(() =>
      expect(client.frames).toContainEqual(
        expect.objectContaining({
          type: "permissionResult",
          wireRequestId: "after-oversize",
          behavior: "allow",
        }),
      ),
    );
  });

  it("accepts fragmented auth and multiple permission frames without losing either", async () => {
    const requests: ClaudePermissionRequest[] = [];
    const broker = new ClaudePermissionBroker({
      panelId: "panel-a",
      sessionId: "session-a",
      mode: "manual",
      onRequest: (request) => {
        requests.push(request);
      },
    });
    brokers.push(broker);
    await broker.start();
    const client = await rawBrokerClient(broker.pipeName);
    const auth = `${JSON.stringify({ type: "auth", token: broker.token, sessionId: "session-a" })}\n`;
    client.socket.write(auth.slice(0, 9));
    client.socket.write(auth.slice(9));
    await vi.waitFor(() =>
      expect(client.frames).toContainEqual(
        expect.objectContaining({ type: "authenticated" }),
      ),
    );
    client.socket.write(
      `${JSON.stringify({ type: "permission", wireRequestId: "one", tool_name: "Read", input: { path: "a.ts" } })}\n${JSON.stringify({ type: "permission", wireRequestId: "two", tool_name: "Edit", input: { path: "b.ts" } })}\n`,
    );
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    requests.forEach((request) =>
      broker.respond({ ...request, decision: "allow" }),
    );
    await vi.waitFor(() => {
      expect(client.frames).toContainEqual(
        expect.objectContaining({ wireRequestId: "one", behavior: "allow" }),
      );
      expect(client.frames).toContainEqual(
        expect.objectContaining({ wireRequestId: "two", behavior: "allow" }),
      );
    });
  });

  it("keeps the secret out of argv and tears down private launch state", async () => {
    const fixture = await brokerFor();
    const args = fixture.broker.claudeArgs();
    expect(args).toEqual([
      "--mcp-config",
      fixture.broker.configPath,
      "--strict-mcp-config",
      "--allowed-tools",
      "mcp__cukii_permission__request",
      "--permission-prompt-tool",
      "mcp__cukii_permission__request",
    ]);
    expect(args.join(" ")).not.toContain(fixture.broker.token);
    expect(args.join(" ")).not.toContain(fixture.broker.pipeName);
    expect(fs.existsSync(fixture.broker.configPath)).toBe(true);
    await fixture.broker.dispose();
    expect(fs.existsSync(fixture.broker.configPath)).toBe(false);
  });

  it("allows exactly the original input after a correlated panel decision", async () => {
    const fixture = await brokerFor();
    const input = { command: "git status" };
    const result = requestPermissionOverPipe({
      pipeName: fixture.broker.pipeName,
      token: fixture.broker.token,
      sessionId: "session-a",
      toolName: "Bash",
      input,
    });
    await vi.waitFor(() => expect(fixture.received).toBeDefined());
    const request = fixture.received!;
    expect(
      fixture.broker.respond({
        runId: request.runId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        inputFingerprint: request.inputFingerprint,
        decision: "allow",
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({
      behavior: "allow",
      updatedInput: input,
    });
  });

  it("denies mismatched token, session, fingerprint and duplicate responses", async () => {
    const fixture = await brokerFor();
    await expect(
      requestPermissionOverPipe({
        pipeName: fixture.broker.pipeName,
        token: "forged-token",
        sessionId: "session-a",
        toolName: "Bash",
        input: { command: "whoami" },
      }),
    ).resolves.toEqual({ behavior: "deny" });
    const input = { path: "safe.ts" };
    const result = requestPermissionOverPipe({
      pipeName: fixture.broker.pipeName,
      token: fixture.broker.token,
      sessionId: "session-a",
      toolName: "Edit",
      input,
    });
    await vi.waitFor(() => expect(fixture.received).toBeDefined());
    const request = fixture.received!;
    expect(
      fixture.broker.respond({
        ...request,
        inputFingerprint: permissionInputFingerprint({ path: "evil.ts" }),
        decision: "allow",
      }),
    ).toBe(false);
    expect(
      fixture.broker.respond({
        ...request,
        sessionId: "session-b",
        decision: "allow",
      }),
    ).toBe(false);
    expect(fixture.broker.respond({ ...request, decision: "deny" })).toBe(true);
    expect(fixture.broker.respond({ ...request, decision: "allow" })).toBe(
      false,
    );
    await expect(result).resolves.toEqual({ behavior: "deny" });
  });

  it("times out, cancels, and prevents a second client from approving", async () => {
    const fixture = await brokerFor("manual", 25);
    await expect(
      requestPermissionOverPipe({
        pipeName: fixture.broker.pipeName,
        token: fixture.broker.token,
        sessionId: "session-a",
        toolName: "Bash",
        input: { command: "whoami" },
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ behavior: "deny" });

    const manual = await brokerFor();
    const pending = requestPermissionOverPipe({
      pipeName: manual.broker.pipeName,
      token: manual.broker.token,
      sessionId: "session-a",
      toolName: "Bash",
      input: { command: "dir" },
    });
    await vi.waitFor(() => expect(manual.received).toBeDefined());
    manual.broker.denyAll();
    await expect(pending).resolves.toEqual({ behavior: "deny" });
  });

  it("disposes an active child request as deny and removes the private config", async () => {
    const fixture = await brokerFor();
    const pending = requestPermissionOverPipe({
      pipeName: fixture.broker.pipeName,
      token: fixture.broker.token,
      sessionId: "session-a",
      toolName: "Bash",
      input: { command: "git clean -fd" },
    });
    await vi.waitFor(() => expect(fixture.received).toBeDefined());
    const configPath = fixture.broker.configPath;
    await fixture.broker.dispose();
    await expect(pending).resolves.toEqual({ behavior: "deny" });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("requires an exact UI verdict for every non-bypass mode", async () => {
    for (const mode of [
      "manual",
      "editAutomatically",
      "auto",
      "plan",
    ] as const) {
      const fixture = await brokerFor(mode);
      const result = requestPermissionOverPipe({
        pipeName: fixture.broker.pipeName,
        token: fixture.broker.token,
        sessionId: "session-a",
        toolName: "Edit",
        input: { path: "a.ts" },
      });
      await vi.waitFor(() => expect(fixture.received).toBeDefined());
      fixture.broker.respond({ ...fixture.received!, decision: "deny" });
      await expect(result).resolves.toEqual({ behavior: "deny" });
      await fixture.broker.dispose();
    }
  });

  it("applies directory ACL before writing secrets and fails closed", async () => {
    let broker!: ClaudePermissionBroker;
    broker = new ClaudePermissionBroker({
      panelId: "panel-a",
      sessionId: "session-a",
      mode: "manual",
      onRequest: () => {},
      restrictDirectory: (directory) => {
        expect(fs.existsSync(directory)).toBe(true);
        expect(fs.existsSync(broker.configPath)).toBe(false);
        expect(fs.readdirSync(directory)).toEqual([]);
        throw new Error("ACL denied");
      },
    });
    brokers.push(broker);
    await expect(broker.start()).rejects.toThrow("ACL denied");
    expect(fs.existsSync(broker.configDirectory)).toBe(false);
  });

  it("accepts exactly one authenticated pipe client", async () => {
    const fixture = await brokerFor();
    const credentials = {
      pipeName: fixture.broker.pipeName,
      token: fixture.broker.token,
      sessionId: "session-a",
    };
    const first = new PermissionPipeClient(credentials);
    const second = new PermissionPipeClient(credentials);
    await expect(first.connect()).resolves.toBe(true);
    await expect(second.connect()).resolves.toBe(false);
    const pending = first.request({
      toolName: "Bash",
      input: { command: "echo first" },
    });
    await vi.waitFor(() => expect(fixture.received).toBeDefined());
    fixture.broker.respond({ ...fixture.received!, decision: "allow" });
    await expect(pending).resolves.toEqual({
      behavior: "allow",
      updatedInput: { command: "echo first" },
    });
    first.dispose();
    second.dispose();
    const replay = new PermissionPipeClient(credentials);
    await expect(replay.connect()).resolves.toBe(false);
    replay.dispose();
  });
});
