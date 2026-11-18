import type { Session } from "core";
import { describe, expect, it } from "vitest";

import { isRestorableCukiiSession } from "./cukiiSessionRestore";

describe("isRestorableCukiiSession", () => {
  it("accepts a saved session without changing its history, title, or model state", () => {
    const saved: Session = {
      sessionId: "saved-session",
      title: "Restore exact state",
      chatModelTitle: "Opus 5",
      workspaceDirectory: "D:/Brain/vault",
      history: [
        {
          message: { id: "user-1", role: "user", content: "Continue" } as any,
          contextItems: [],
        },
      ],
    };

    expect(isRestorableCukiiSession(saved)).toBe(true);
    expect(saved).toMatchObject({
      title: "Restore exact state",
      chatModelTitle: "Opus 5",
      history: [{ message: { id: "user-1" } }],
    });
  });

  it("rejects the empty HistoryManager fallback so it cannot make a false blank tab", () => {
    expect(
      isRestorableCukiiSession({
        sessionId: "missing-session",
        title: "New Session",
        workspaceDirectory: "",
        history: [],
      }),
    ).toBe(false);
  });
});
