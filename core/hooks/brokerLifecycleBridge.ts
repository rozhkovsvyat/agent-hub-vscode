import net from "node:net";

type LifecycleBinding = {
  bridgeSessionId: string;
  token: string;
  state: "starting" | "ready" | "failed";
  start: Promise<void>;
  resolveStart: () => void;
  rejectStart: (error: Error) => void;
  tail: Promise<void>;
};
const bindings = new Map<string, LifecycleBinding>();

/** Bind an explicitly chosen GUI chat, never a FIFO "next session". */
export function bindBrokerLifecycleBinding(
  chatSessionId: string,
  bridgeSessionId: string,
  token: string,
): void {
  if (!chatSessionId || !bridgeSessionId || !token)
    throw new Error("incomplete broker lifecycle binding");
  if (bindings.has(chatSessionId))
    throw new Error("chat already has a broker lifecycle binding");
  let resolveStart!: () => void;
  let rejectStart!: (error: Error) => void;
  const start = new Promise<void>((resolve, reject) => {
    resolveStart = resolve;
    rejectStart = reject;
  });
  // A listener may attach before Core begins the network operation.  The
  // rejection is observed by waiting lifecycle calls, never as an unhandled
  // promise rejection.
  void start.catch(() => undefined);
  bindings.set(chatSessionId, {
    bridgeSessionId,
    token,
    state: "starting",
    start,
    resolveStart,
    rejectStart,
    tail: Promise.resolve(),
  });
}

function claimBinding(chatSessionId: string): LifecycleBinding | undefined {
  const bound = bindings.get(chatSessionId);
  return bound;
}

async function send(
  binding: LifecycleBinding,
  event: string,
  chatSessionId: string,
  cwd: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 8766 });
    const timeout = setTimeout(
      () => socket.destroy(new Error("broker lifecycle timeout")),
      1500,
    );
    socket.setEncoding("utf8");
    let reply = "";
    socket.once("connect", () =>
      socket.write(
        `${JSON.stringify({
          id: `deepseek-${binding.bridgeSessionId}-${event}`,
          method: "bridge_lifecycle_event",
          params: {
            token: binding.token,
            agent: "deepseek",
            session_id: binding.bridgeSessionId,
            event,
            cwd,
            payload: { ...payload, chat_session_id: chatSessionId },
          },
        })}\n`,
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
        if (frame.error || !frame.result?.accepted)
          throw new Error("broker lifecycle rejected");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

function enqueue(
  chatSessionId: string,
  binding: LifecycleBinding,
  operation: () => Promise<void>,
): Promise<void> {
  const result = binding.tail.then(operation);
  binding.tail = result.catch(() => {
    binding.state = "failed";
    bindings.delete(chatSessionId);
  });
  return result;
}

/** Start is serialized before every later event for this exact chat binding. */
export async function startBrokerLifecycleBinding(
  chatSessionId: string,
  cwd: string,
): Promise<void> {
  const binding = claimBinding(chatSessionId);
  if (!binding || binding.state !== "starting")
    throw new Error("broker lifecycle binding is not starting");
  try {
    await send(binding, "SessionStart", chatSessionId, cwd, {
      source: "explicit-ui-bind",
    });
    binding.state = "ready";
    binding.resolveStart();
  } catch (error) {
    bindings.delete(chatSessionId);
    binding.rejectStart(
      error instanceof Error
        ? error
        : new Error("broker lifecycle start failed"),
    );
    throw error;
  }
}

/** Best-effort telemetry transport. Local hooks remain the enforcement path. */
export async function emitBrokerLifecycle(
  event: string,
  sessionId: string,
  cwd: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const binding = claimBinding(sessionId);
  if (!binding) return;
  // Local SessionStart can happen after the explicit broker start; it is a
  // duplicate by definition.  All other lifecycle events wait atomically.
  if (event === "SessionStart") return;
  if (binding.state === "starting") await binding.start;
  await enqueue(sessionId, binding, async () => {
    if (binding.state === "starting") await binding.start;
    if (binding.state !== "ready")
      throw new Error("broker lifecycle binding failed");
    await send(binding, event, sessionId, cwd, payload);
  });
}
