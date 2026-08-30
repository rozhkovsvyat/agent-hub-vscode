import * as fs from "fs";
import * as path from "path";
import { performance } from "perf_hooks";
import { Session } from "..";
import { HistoryConflictError, HistoryManager } from "./history";

const barrier = process.env.CUKII_HISTORY_BARRIER!;
const label = process.env.CUKII_HISTORY_LABEL!;
const operation = process.env.CUKII_HISTORY_OPERATION!;
const session = JSON.parse(
  process.env.CUKII_HISTORY_SESSION || "{}",
) as Session;
const wait = async (file: string) => {
  for (let i = 0; i < 3_000; i++) {
    if (fs.existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
};
test("isolated history mutation", async () => {
  const manager = new HistoryManager({
    beforeMutation: async () => {
      fs.writeFileSync(path.join(barrier, `${label}.ready`), "");
      await wait(path.join(barrier, "release"));
    },
  });
  try {
    if (operation === "list") {
      const started = performance.now();
      const rows = await manager.list({});
      fs.writeFileSync(
        path.join(barrier, `${label}.result.json`),
        JSON.stringify({
          ok: true,
          rows,
          operationMs: performance.now() - started,
        }),
      );
      return;
    }
    if (operation === "save") await manager.save(session);
    else if (operation === "delete") await manager.delete(session.sessionId);
    else if (operation === "clear") await manager.clearAll();
    else throw new Error(`Unknown operation ${operation}`);
    fs.writeFileSync(
      path.join(barrier, `${label}.result.json`),
      JSON.stringify({ ok: true }),
    );
  } catch (error) {
    fs.writeFileSync(
      path.join(barrier, `${label}.result.json`),
      JSON.stringify({
        ok: false,
        conflict: error instanceof HistoryConflictError,
        message: String(error),
      }),
    );
    if (!(error instanceof HistoryConflictError)) throw error;
  } finally {
    await manager.close();
  }
});
