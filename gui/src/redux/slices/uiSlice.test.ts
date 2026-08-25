import { describe, expect, it, vi } from "vitest";

vi.mock("../../util/localStorage", () => ({
  getLocalStorage: () => undefined,
  setLocalStorage: vi.fn(),
  LocalStorageKey: {
    IsExploreDialogOpen: "isExploreDialogOpen",
    HasDismissedExploreDialog: "hasDismissedExploreDialog",
    FocusView: "focusView",
  },
}));

import {
  setAllowAllPermissions,
  setFocusView,
  setThinkingCollapse,
  setToolPolicy,
  syncAllowAllPermissions,
} from "./uiSlice";
import reducer, { DEFAULT_UI_SLICE } from "./uiSlice";
import { setLocalStorage } from "../../util/localStorage";

describe("allow all tool permissions", () => {
  it("makes every known tool automatic when enabled", () => {
    const state = reducer(
      undefined,
      setAllowAllPermissions({
        enabled: true,
        toolNames: ["read_file", "run_terminal_command"],
      }),
    );

    expect(state.allowAllPermissions).toBe(true);
    expect(state.toolSettings).toEqual({
      read_file: "allowedWithoutPermission",
      run_terminal_command: "allowedWithoutPermission",
    });
  });

  it("keeps policies but clears the toggle after an individual override", () => {
    const enabled = reducer(
      undefined,
      setAllowAllPermissions({ enabled: true, toolNames: ["read_file"] }),
    );
    const changed = reducer(
      enabled,
      setToolPolicy({ toolName: "read_file", policy: "disabled" }),
    );

    expect(changed.allowAllPermissions).toBe(false);
    expect(changed.toolSettings).toEqual({ read_file: "disabled" });
  });

  it("returns every known tool to Ask First when disabled", () => {
    const enabled = reducer(
      undefined,
      setAllowAllPermissions({
        enabled: true,
        toolNames: ["read_file", "run_terminal_command"],
      }),
    );
    const disabled = reducer(
      enabled,
      setAllowAllPermissions({
        enabled: false,
        toolNames: ["read_file", "run_terminal_command"],
      }),
    );

    expect(disabled.allowAllPermissions).toBe(false);
    expect(disabled.toolSettings).toEqual({
      read_file: "allowedWithPermission",
      run_terminal_command: "allowedWithPermission",
    });
  });

  it("reflects individual policies back into the master toggle", () => {
    const allAutomatic = reducer(
      undefined,
      setAllowAllPermissions({
        enabled: true,
        toolNames: ["read_file", "run_terminal_command"],
      }),
    );
    const mixed = reducer(
      allAutomatic,
      setToolPolicy({
        toolName: "read_file",
        policy: "allowedWithPermission",
      }),
    );
    const synchronized = reducer(
      mixed,
      syncAllowAllPermissions({
        toolNames: ["read_file", "run_terminal_command"],
      }),
    );

    expect(synchronized.allowAllPermissions).toBe(false);
  });
});

describe("thinking collapse", () => {
  it("bumps version and sets open=false", () => {
    const state = reducer(undefined, setThinkingCollapse(false));
    expect(state.thinkingCollapse).toEqual({ version: 1, open: false });
  });
});

describe("focus view", () => {
  it("defaults to false", () => {
    expect(DEFAULT_UI_SLICE.focusView).toBe(false);
  });

  it("toggles focusView and persists", () => {
    const state = reducer(undefined, setFocusView(true));
    expect(state.focusView).toBe(true);
    expect(setLocalStorage).toHaveBeenCalledWith("focusView", true);

    const off = reducer(state, setFocusView(false));
    expect(off.focusView).toBe(false);
    expect(setLocalStorage).toHaveBeenCalledWith("focusView", false);
  });
});
