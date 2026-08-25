import { describe, expect, it, vi } from "vitest";

vi.mock("../../util/localStorage", () => ({
  getLocalStorage: () => undefined,
  LocalStorageKey: {
    IsExploreDialogOpen: "isExploreDialogOpen",
    HasDismissedExploreDialog: "hasDismissedExploreDialog",
  },
}));

import {
  setAllowAllPermissions,
  setThinkingCollapse,
  setToolPolicy,
  syncAllowAllPermissions,
} from "./uiSlice";
import reducer from "./uiSlice";

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
