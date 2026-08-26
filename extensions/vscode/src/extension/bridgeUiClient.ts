import net from "node:net";

type RpcResult = Record<string, unknown>;

async function call(
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 8766 });
    const timeout = setTimeout(
      () => socket.destroy(new Error("Cukii broker timeout")),
      2000,
    );
    socket.setEncoding("utf8");
    let reply = "";
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({ id: `ui-${Date.now()}`, method, params })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      reply += chunk;
      if (reply.includes("\n")) socket.end();
    });
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timeout);
      try {
        const frame = JSON.parse(reply.trim());
        if (frame.error) throw new Error("broker rejected request");
        resolve(frame.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export type BridgeScope = { name: string; root: string };

export async function listBridgeScopes(token: string): Promise<BridgeScope[]> {
  const result = await call("bridge_scopes", { token });
  return Array.isArray(result.scopes)
    ? result.scopes.filter(
        (x): x is BridgeScope =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as BridgeScope).name === "string" &&
          typeof (x as BridgeScope).root === "string",
      )
    : [];
}

export async function openBridgeSession(args: {
  token: string;
  session_id: string;
  agent: string;
  role: string;
  scope: string;
  task_id: string;
  parent_session_id?: string;
}): Promise<RpcResult> {
  return call("bridge_open_session", args);
}

export async function recoverBridgeSession(args: {
  token: string;
  session_id: string;
  agent: string;
  role: string;
  scope: string;
  task_id: string;
  parent_session_id?: string;
}): Promise<RpcResult> {
  return call("bridge_recover_session", args);
}

export async function listBrokerSessions(
  token: string,
  scope: string,
): Promise<Array<{ session_id: string; agent: string }>> {
  const result = await call("bridge_broker_sessions", { token, scope });
  return Array.isArray(result.sessions)
    ? result.sessions.filter(
        (x): x is { session_id: string; agent: string } =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as { session_id?: unknown }).session_id === "string" &&
          typeof (x as { agent?: unknown }).agent === "string",
      )
    : [];
}

export async function delegateBridgeWorker(args: {
  token: string;
  parent_session_id: string;
  agent: string;
  task_id: string;
  task: string;
  model?: string;
}): Promise<RpcResult> {
  return call("bridge_delegate_worker", args);
}

export async function pollWorkerStatus(
  scope: string,
  taskId: string,
): Promise<{ status?: string; worker_status?: string }> {
  return call("worker_status", { scope_name: scope, task_id: taskId });
}
