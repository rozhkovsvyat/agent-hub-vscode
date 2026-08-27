import {
  assertExactResourceBinding,
  assertSemanticTransition,
  assertStableCapture,
} from "./oracle-guards.mjs";

const base = {
  outerSrc: "vscode-webview://stable",
  tuple: { id: "stable" },
  targetId: "target-1",
  targetUrl: "vscode-webview://stable",
  box: { x: 1, y: 2, width: 300, height: 800 },
  workbenchViewport: { width: 1200, height: 900, dpr: 1.5 },
  bodyTextSha256: "text-a",
  visibleInteractiveSha256: "interactive-a",
  innerViewport: { width: 300, height: 800, dpr: 1.5 },
  resources: ["index.js", "index.css"],
};

const cases = [
  ["no-op-click", () => assertSemanticTransition("no-op-click", { visibleCount: 0 }, { visibleCount: 0 })],
  ["stale-src", () => assertStableCapture(base, { ...base, outerSrc: "vscode-webview://stale" })],
  ["resize", () => assertStableCapture(base, { ...base, box: { ...base.box, width: 299 } })],
  ["empty-resources", () => assertExactResourceBinding({ resources: [], resourceBinding: [] }, "cukii.cukii-vscode")],
];

const results = [];
for (const [name, run] of cases) {
  let rejected = false;
  try {
    run();
  } catch (error) {
    rejected = true;
    results.push({ name, rejected, message: error instanceof Error ? error.message : String(error) });
  }
  if (!rejected) results.push({ name, rejected });
}
const pass = results.every((result) => result.rejected);
process.stdout.write(`${JSON.stringify({ status: pass ? "SELFTEST-PASS" : "SELFTEST-FAIL", results }, null, 2)}\n`);
if (!pass) process.exitCode = 2;
