import { describe, expect, it } from "vitest";
import { stoppedRequestTexts } from "./stoppedRequests";

const u = (id: string, text: string) =>
  ({ message: { id, role: "user", content: text }, contextItems: [] }) as any;
const a = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    message: { id, role: "assistant", content: "x" },
    contextItems: [],
    ...extra,
  }) as any;

describe("stoppedRequestTexts", () => {
  it("names requests whose turn was stopped and skips the message being sent", () => {
    const history = [
      u("1", "run X166"),
      a("a1", { interrupted: true }),
      u("2", "run Y166"),
      a("a2", { toolCallStates: [{ status: "canceled" }] }),
      u("3", "answer PARB"),
      a("a3"),
      u("4", "PAR-A now"),
    ];
    expect(stoppedRequestTexts(history)).toEqual(["run X166", "run Y166"]);
  });

  it("returns nothing when no recent turn was stopped", () => {
    expect(
      stoppedRequestTexts([u("1", "hi"), a("a1"), u("2", "next")]),
    ).toEqual([]);
  });
});
