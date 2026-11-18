import { describe, expect, it } from "vitest";

import { CukiiActiveEditorSelectionState } from "./cukiiActiveEditorSelection";

describe("CukiiActiveEditorSelectionState", () => {
  it("keeps a newer live push when the initial query resolves later", async () => {
    const state = new CukiiActiveEditorSelectionState();
    const epoch = state.beginInitialQuery();
    let resolveInitial: (hasSelection: boolean) => void;
    const initial = new Promise<boolean>((resolve) => {
      resolveInitial = resolve;
    });

    state.applyLiveUpdate(true);
    resolveInitial!(false);

    expect(state.applyInitialResponse(epoch, await initial)).toBe(false);
    expect(state.value()).toBe(true);
  });
});
