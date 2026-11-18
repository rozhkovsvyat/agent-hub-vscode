import { describe, expect, it } from "vitest";
import { parseNestedWorkerThinking } from "./NestedWorkerCard";

describe("parseNestedWorkerThinking", () => {
  it("parses a live Composer job and keeps the latest log line", () => {
    const view = parseNestedWorkerThinking(
      "[Composer 2.5 job 260825130844-883400-0000]\nworker started\nstill running\n",
      true,
    );
    expect(view).toEqual({
      kind: "composer",
      title: "Composer 2.5",
      identity: "260825130844-883400-0000",
      status: "running",
      lastLine: "still running",
    });
  });

  it("treats an empty live Composer header as launching, not generic thinking", () => {
    expect(
      parseNestedWorkerThinking(
        "[Composer 2.5 job 260825130844-883400-0000]\n",
        true,
      )?.status,
    ).toBe("launching");
  });

  it("uses the latest broker status line after polls", () => {
    const view = parseNestedWorkerThinking(
      "[broker hub/t1] status: running\n[broker hub/t1] status: done\n",
      false,
    );
    expect(view).toEqual({
      kind: "broker",
      title: "Broker",
      identity: "hub/t1",
      status: "done",
      lastLine: "status: done",
    });
  });

  it("marks failed broker workers even while the parent stream is still open", () => {
    expect(
      parseNestedWorkerThinking("[broker work/abc] status: failed\n", true)
        ?.status,
    ).toBe("failed");
  });

  it("ignores ordinary thinking", () => {
    expect(
      parseNestedWorkerThinking("Considering the next edit.", true),
    ).toBeNull();
  });
});
