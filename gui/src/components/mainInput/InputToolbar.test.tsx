import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "fs";
import { join } from "path";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import {
  newSession,
  setBrokerAutocompact,
  setBrokerEffort,
  setBrokerModel,
  setBrokerPermissionMode,
  setBrokerSpeed,
} from "../../redux/slices/sessionSlice";
import { setupStore } from "../../redux/store";
import { renderWithProviders } from "../../util/test/render";
import { getElementByText, getElementByTestId } from "../../util/test/utils";
import InputToolbar, { availableModelForBlankSession } from "./InputToolbar";

const canonicalCss = () =>
  readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

describe("Cukii Claude-parity input toolbar", () => {
  const props = {
    activeKey: null,
    isMainInput: true,
    isInputEmpty: true,
    onEnter: vi.fn(),
    onAddContextItem: vi.fn(),
    onFilesSelected: vi.fn(),
  };

  const originalCukiiVscode = window.cukiiVscode;

  afterEach(() => {
    cleanup();
    window.cukiiVscode = originalCukiiVscode;
  });

  const retainInitializedSession = (
    mockIdeMessenger: MockIdeMessenger,
    store: ReturnType<typeof setupStore>,
  ) => {
    mockIdeMessenger.responseHandlers["history/load"] = async () => {
      const session = store.getState().session;
      return {
        sessionId: session.id,
        title: session.title,
        workspaceDirectory: "",
        history: session.history,
        mode: session.mode,
        brokerModel: session.brokerModel,
        brokerSubagent: session.brokerSubagent,
        brokerEffort: session.brokerEffort,
        brokerSpeed: session.brokerSpeed,
        hasReasoningEnabled: session.hasReasoningEnabled,
        brokerPermissionMode: session.brokerPermissionMode,
      };
    };
  };

  const seedSavedHistory = (store: ReturnType<typeof setupStore>) => {
    const session = store.getState().session;
    store.dispatch(
      newSession({
        sessionId: session.id,
        title: session.title,
        workspaceDirectory: "",
        history: [
          {
            message: {
              role: "user",
              content: "Persist the selected broker preferences",
            },
            contextItems: [],
          },
        ],
        mode: session.mode,
        brokerModel: session.brokerModel,
        brokerSubagent: session.brokerSubagent,
        brokerEffort: session.brokerEffort,
        brokerSpeed: session.brokerSpeed,
        hasReasoningEnabled: session.hasReasoningEnabled,
        brokerPermissionMode: session.brokerPermissionMode,
      }),
    );
  };

  it("shows attach, slash, permission mode and submit controls", async () => {
    const { ideMessenger, user } = await renderWithProviders(
      <InputToolbar {...props} />,
    );
    ideMessenger.responses["cukii/pickAttachmentFiles"] = [
      { path: "D:/Docs/spec.pdf", name: "spec.pdf" },
    ];

    expect(
      document.querySelector('[data-testid="mode-select-button"]'),
    ).toBeNull();
    const attach = await getElementByTestId("cukii-attach-menu-button");
    const commands = await getElementByTestId("broker-menu-button");
    expect(attach.querySelector('svg[viewBox="0 0 20 20"]')).not.toBeNull();
    expect(commands.querySelector('svg[viewBox="0 0 20 20"]')).not.toBeNull();
    expect(await getElementByText("Bypass permissions")).toBeDefined();

    await user.click(attach);
    await user.click(await getElementByText("Upload from computer"));
    expect(props.onFilesSelected).toHaveBeenCalledWith([
      { path: "D:/Docs/spec.pdf", name: "spec.pdf" },
    ]);
    await user.click(attach);
    expect(await getElementByText("Add context")).toBeDefined();
  });

  it("selects the first live model for a blank session when the bootstrap default is unavailable", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responses["cukii/listBrokerModelCatalog"] = [
      {
        id: "claude",
        label: "Anthropic",
        models: [
          { value: "opus-5", label: "Opus 5", contextWindowLabel: "1M" },
        ],
      },
    ];
    const store = setupStore({ ideMessenger: mockIdeMessenger });

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await waitFor(() => {
      expect(store.getState().session.brokerModel).toBe("opus-5");
    });
  });

  it("keeps an explicit model when it is live and returns no guess for an empty catalog", () => {
    const live = [
      {
        id: "codex" as const,
        label: "OpenAI",
        models: [
          {
            value: "codex-5-6-sol" as const,
            label: "GPT-5.6 Sol",
            contextWindowLabel: "272K",
          },
        ],
      },
    ];
    expect(availableModelForBlankSession("codex-5-6-sol", live)).toBe(
      "codex-5-6-sol",
    );
    expect(availableModelForBlankSession("qwen-3-8-max", [])).toBeUndefined();
  });

  it("hides every vendor-dependent control when no CLI exposes a live model", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    let catalogRequests = 0;
    mockIdeMessenger.responseHandlers["cukii/listBrokerModelCatalog"] =
      async () => {
        catalogRequests += 1;
        return [];
      };

    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
    });

    await waitFor(() => expect(catalogRequests).toBe(1));
    expect(
      document.querySelector('[data-testid="cukii-model-pill"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Bypass permissions");

    await user.click(await getElementByTestId("broker-menu-button"));
    expect(await getElementByText("Manage accounts…")).toBeDefined();
    expect(
      document.querySelector('[data-testid="broker-switch-model"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-autocompact-slider"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-effort-slider"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-thinking-toggle"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-speed-toggle"]'),
    ).toBeNull();
  });

  it("reconciles the bootstrap model after the first account login closes", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    let catalogRequests = 0;
    mockIdeMessenger.responseHandlers["cukii/listBrokerModelCatalog"] =
      async () => {
        catalogRequests += 1;
        return catalogRequests === 1
          ? []
          : [
              {
                id: "codex" as const,
                label: "OpenAI",
                models: [
                  {
                    value: "codex-5-6-sol" as const,
                    label: "GPT-5.6 Sol",
                    contextWindowLabel: "272K",
                  },
                ],
              },
            ];
      };
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });
    await waitFor(() => expect(catalogRequests).toBe(1));
    expect(store.getState().session.brokerModel).toBe("qwen-3-8-max");

    await user.click(await getElementByTestId("broker-menu-button"));
    await user.click(await getElementByText("Manage accounts…"));
    await user.click(
      await screen.findByRole("button", { name: "Close vendor accounts" }),
    );

    await waitFor(() => expect(catalogRequests).toBe(2));
    await waitFor(() =>
      expect(store.getState().session.brokerModel).toBe("codex-5-6-sol"),
    );
  });

  it("shows a Claude-style model pill beside the slash control that opens the model picker", async () => {
    const { user } = await renderWithProviders(<InputToolbar {...props} />);

    const pill = await getElementByTestId("cukii-model-pill");
    expect(pill).toHaveAttribute(
      "aria-label",
      "Selected model: Qwen 3.8 Max, High 50%",
    );
    // Claude pill geometry, measured on the live client: an 18px capsule with
    // 8px horizontal padding and 11.05px text.
    expect(pill.className).toContain("h-[18px]");
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("px-2");
    expect(pill.className).toContain("text-[11.05px]");
    // It rides directly next to the "/" command control in the left cluster.
    const slashControl = await getElementByTestId("broker-menu-button");
    expect(slashControl.closest(".relative")?.nextElementSibling).toBe(pill);

    await user.click(pill);

    // The same picker as "Switch model…" opens, with the Milky toggle on.
    expect(await getElementByText("Select a model")).toBeDefined();
    const milkyToggle = await getElementByTestId("cukii-scope-toggle-milky");
    expect(milkyToggle).toHaveAttribute("aria-pressed", "true");
  });

  it("composes the pill as model, effort, Fast, autocompact — model plain, the rest muted", async () => {
    const store = setupStore({ ideMessenger: new MockIdeMessenger() });
    await act(async () => {
      store.dispatch(setBrokerModel("codex-5-6-sol"));
      store.dispatch(setBrokerEffort("max"));
      store.dispatch(setBrokerSpeed("fast"));
      store.dispatch(setBrokerAutocompact("75"));
    });
    await renderWithProviders(<InputToolbar {...props} />, { store });

    const pill = await getElementByTestId("cukii-model-pill");
    const detail = await getElementByTestId("cukii-model-pill-detail");

    // Exactly the owner's example shape: "GPT-5.6 Sol Max Fast 75%".
    expect(pill.textContent).toBe("GPT-5.6 SolMax Fast 75%");
    expect(detail.textContent).toBe("Max Fast 75%");
    // The model name keeps the foreground colour; the detail is muted.
    expect(detail.className).toContain("--vscode-descriptionForeground");
    const name = pill.firstElementChild as HTMLElement;
    expect(name.textContent).toBe("GPT-5.6 Sol");
    expect(name.className).not.toContain("descriptionForeground");
  });

  it("drops Fast when the route has no accelerated tier and drops autocompact at Default", async () => {
    const store = setupStore({ ideMessenger: new MockIdeMessenger() });
    await act(async () => {
      // Kimi has no native accelerated tier, so "fast" must not be advertised
      // even when the stored preference says fast.
      store.dispatch(setBrokerModel("kimi-k3"));
      store.dispatch(setBrokerEffort("medium"));
      store.dispatch(setBrokerSpeed("fast"));
      store.dispatch(setBrokerAutocompact("default"));
    });
    await renderWithProviders(<InputToolbar {...props} />, { store });

    const detail = await getElementByTestId("cukii-model-pill-detail");
    expect(detail.textContent).toBe("Medium");
    expect(detail.textContent).not.toContain("Fast");
    expect(detail.textContent).not.toContain("Default");
  });

  it("offers Autocompact directly above Effort in the slash menu and stores the pick", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      store,
    });

    await user.click(await getElementByTestId("broker-menu-button"));
    const menu = await getElementByTestId("cukii-slash-menu");

    const autocompact = await getElementByTestId("cukii-autocompact-slider");
    const effort = await getElementByTestId("cukii-effort-slider");
    expect(menu.contains(autocompact)).toBe(true);
    // Order matters: Autocompact sits above Effort, as asked.
    expect(
      autocompact.compareDocumentPosition(effort) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Four stops, default 50% — the middle-left notch.
    expect(autocompact).toHaveAttribute("aria-valuemax", "3");
    expect(autocompact).toHaveAttribute("aria-valuetext", "50%");

    // jsdom reports a zero-width track, so a click lands on the first stop.
    await user.click(autocompact);
    expect(store.getState().session.brokerAutocompact).toBe("25");
  });

  it("aligns the effort and autocompact sliders with the plain toggles on the right edge", async () => {
    const { user } = await renderWithProviders(<InputToolbar {...props} />);
    await user.click(await getElementByTestId("broker-menu-button"));

    // Both rows use the shared menu row, whose justify-between pins the control
    // to the right edge; the slider itself must carry no extra side margin or
    // it reads as misaligned against the toggle tracks.
    for (const id of ["cukii-autocompact-slider", "cukii-effort-slider"]) {
      const slider = await getElementByTestId(id);
      const row = slider.parentElement as HTMLElement;
      expect(row.className).toContain("justify-between");
      expect(slider.className).toContain("cukii-effort-slider");
    }
  });

  it("opens the Cukii permission popover with exact copy and cycles with Shift+Tab", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({ type: "session/setBrokerModel", payload: "opus-5" });
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByText("Bypass permissions"));
    expect(await getElementByText("Modes")).toBeDefined();
    expect(await getElementByText("⇧ + tab to switch")).toBeDefined();
    expect(document.querySelector('[aria-label="Shift+Tab"]')).not.toBeNull();
    expect(
      await getElementByText(
        "Cukii will explore the code and present a plan before editing",
      ),
    ).toBeDefined();
    expect(
      await getElementByText(
        "Cukii will not ask for approval before running potentially dangerous commands",
      ),
    ).toBeDefined();

    await user.click(await getElementByTestId("cukii-permission-mode-bypass"));
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(await getElementByText("Bypass permissions")).toBeDefined();

    const composer = document.createElement("div");
    composer.contentEditable = "true";
    document.body.append(composer);
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(store.getState().session.brokerPermissionMode).toBe("manual");
    composer.remove();

    await user.click(await getElementByText("Manual"));
    const selected = document.querySelector(".cukii-permission-mode-selected");
    expect(selected).not.toBeNull();
    expect(
      selected?.querySelector('[data-testid="cukii-permission-icon-manual"]'),
    ).not.toBeNull();
    expect(selected?.querySelector("svg")).not.toBeNull();
    expect(
      document.querySelector(".cukii-permission-mode-icon"),
    ).not.toBeNull();
    for (const icon of document.querySelectorAll(
      ".cukii-permission-mode-icon",
    )) {
      expect(icon).toHaveAttribute("viewBox", "0 0 20 20");
    }
    const css = canonicalCss();
    const permissionCss = css.slice(
      css.indexOf(".cukii-permission-popover {"),
      css.indexOf("@media screen and (max-width: 300px)"),
    );
    expect(permissionCss).toContain("width: 300px;");
    // Claude metrics: content-sized rows and theme-driven selection colors.
    expect(permissionCss).not.toContain("min-height: 52px;");
    expect(permissionCss).toContain("padding: 4px 8px;");
    expect(permissionCss).toContain("gap: 10px;");
    expect(permissionCss).toContain(
      "background: var(--vscode-list-activeSelectionBackground, #04395e) !important;",
    );
  });

  it("keeps the preserved mode visible when live capabilities are empty", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] =
      async ({ vendor }) => ({
        vendor,
        supportedModes: [],
        generation: 1,
        helpSource: "live empty",
      });

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
    });

    const button = document.querySelector(
      '[aria-label="Toggle permission mode"]',
    );
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Bypass permissions");
  });

  it("uses the successful live capability set as authoritative", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] =
      async ({ vendor }) => ({
        vendor,
        supportedModes: vendor === "claude" ? ["plan", "bypass"] : ["bypass"],
        generation: 1,
        helpSource: "live exact route",
      });
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({ type: "session/setBrokerModel", payload: "opus-5" });

    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByText("Bypass permissions"));
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-plan"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-bypass"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-manual"]'),
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-testid="cukii-permission-mode-editAutomatically"]',
      ),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="cukii-permission-mode-auto"]'),
    ).toBeNull();
  });

  it.each([
    ["manual", "Manual"],
    ["editAutomatically", "Edit automatically"],
    ["plan", "Plan"],
    ["auto", "Auto"],
    ["bypass", "Bypass permissions"],
  ] as const)(
    "persists Qwen %s from the live five-mode picker",
    async (mode, title) => {
      const mockIdeMessenger = new MockIdeMessenger();
      mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] =
        async ({ vendor }) => ({
          vendor,
          supportedModes: [
            "manual",
            "editAutomatically",
            "plan",
            "auto",
            "bypass",
          ],
          cliVersion: "0.22.2",
          generation: 1,
          helpSource: "live qwen",
        });
      const postSpy = vi.spyOn(mockIdeMessenger, "post");
      const store = setupStore({ ideMessenger: mockIdeMessenger });
      store.dispatch({
        type: "session/setBrokerModel",
        payload: "qwen-3-8-max",
      });
      store.dispatch(setBrokerPermissionMode("bypass"));
      seedSavedHistory(store);
      retainInitializedSession(mockIdeMessenger, store);

      const { user } = await renderWithProviders(<InputToolbar {...props} />, {
        mockIdeMessenger,
        store,
      });

      await user.click(await getElementByText("Bypass permissions"));
      await user.click(
        await getElementByTestId(`cukii-permission-mode-${mode}`),
      );

      expect(store.getState().session.brokerPermissionMode).toBe(mode);
      expect(postSpy).toHaveBeenCalledWith(
        "cukii/setBrokerPreferences",
        expect.objectContaining({ brokerPermissionMode: mode }),
      );
      expect(await getElementByText(title)).toBeDefined();
    },
  );

  it("switches Manual to a supported mode in session state and persists the bridge preference", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({ type: "session/setBrokerModel", payload: "opus-5" });
    store.dispatch(setBrokerPermissionMode("manual"));
    seedSavedHistory(store);
    retainInitializedSession(mockIdeMessenger, store);
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByText("Manual"));
    await user.click(await getElementByText("Plan"));

    expect(store.getState().session.brokerPermissionMode).toBe("plan");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({ brokerPermissionMode: "plan" }),
    );
  });

  it("reconciles Manual against the target model before persisting a model switch", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] =
      async ({ vendor }) => ({
        vendor,
        supportedModes: vendor === "claude" ? ["manual", "bypass"] : ["bypass"],
        generation: 1,
        helpSource: "live exact route",
      });
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({ type: "session/setBrokerModel", payload: "opus-5" });
    store.dispatch(setBrokerPermissionMode("manual"));
    seedSavedHistory(store);
    retainInitializedSession(mockIdeMessenger, store);
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await getElementByText("Manual");
    await user.click(await getElementByTestId("broker-menu-button"));
    await user.click(await getElementByTestId("broker-switch-model"));
    await user.click(await getElementByText("Kimi K3"));

    expect(store.getState().session.brokerModel).toBe("kimi-k3");
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({
        brokerModel: "kimi-k3",
        brokerPermissionMode: "bypass",
      }),
    );
  });

  it("starts Qwen in Bypass instead of inheriting Plan from the previous model", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({ type: "session/setBrokerModel", payload: "opus-5" });
    store.dispatch(setBrokerPermissionMode("plan"));
    seedSavedHistory(store);
    retainInitializedSession(mockIdeMessenger, store);

    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });
    await user.click(await getElementByTestId("broker-menu-button"));
    await user.click(await getElementByTestId("broker-switch-model"));
    await user.click(await getElementByText("Qwen 3.8 Max"));

    expect(store.getState().session.brokerModel).toBe("qwen-3-8-max");
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({
        brokerModel: "qwen-3-8-max",
        brokerPermissionMode: "bypass",
      }),
    );
  });

  it("retains a blank-tab draft without advertising modes while the native probe is pending", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] = () =>
      new Promise<never>(() => {});
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch(setBrokerPermissionMode("bypass"));

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(
      document.querySelector('[aria-label="Toggle permission mode"]'),
    ).toBeNull();
  });

  it.each(["codex-5-6-sol", "kimi-k3"] as const)(
    "preserves state but advertises no mode for %s while discovery is unavailable",
    async (model) => {
      const mockIdeMessenger = new MockIdeMessenger();
      mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] =
        () => new Promise<never>(() => {});
      const store = setupStore({ ideMessenger: mockIdeMessenger });
      store.dispatch({ type: "session/setBrokerModel", payload: model });
      store.dispatch(setBrokerPermissionMode("manual"));

      await renderWithProviders(<InputToolbar {...props} />, {
        mockIdeMessenger,
        store,
      });

      expect(
        document.querySelector('[aria-label="Toggle permission mode"]'),
      ).toBeNull();
      expect(store.getState().session.brokerPermissionMode).toBe("manual");
    },
  );

  it("keeps the Codex selector reachable after a capability probe error", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] =
      async () => {
        throw new Error("capability probe failed");
      };
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({
      type: "session/setBrokerModel",
      payload: "codex-5-6-sol",
    });
    store.dispatch(setBrokerPermissionMode("bypass"));

    await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    const button = await waitFor(() => {
      const found = document.querySelector(
        '[aria-label="Toggle permission mode"]',
      );
      expect(found).not.toBeNull();
      return found;
    });
    expect(button?.textContent).toContain("Bypass permissions");
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
  });

  it("preserves explicit Kimi Bypass intent while the live probe is pending", async () => {
    let panelState: Record<string, unknown> = {};
    window.cukiiVscode = {
      getState: () => panelState,
      setState: (nextState) => {
        panelState = nextState;
      },
    };
    const mockIdeMessenger = new MockIdeMessenger();
    mockIdeMessenger.responseHandlers["cukii/getPermissionCapabilities"] = () =>
      new Promise<never>(() => {});
    const postSpy = vi.spyOn(mockIdeMessenger, "post");
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch(setBrokerPermissionMode("manual"));
    seedSavedHistory(store);
    retainInitializedSession(mockIdeMessenger, store);
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByTestId("broker-menu-button"));
    await user.click(await getElementByTestId("broker-switch-model"));
    await user.click(await getElementByText("Kimi K3"));

    expect(store.getState().session.brokerModel).toBe("kimi-k3");
    expect(store.getState().session.brokerPermissionMode).toBe("bypass");
    expect(window.cukiiVscode?.getState()?.cukiiBrokerDraft).toMatchObject({
      brokerModel: "kimi-k3",
      brokerPermissionMode: "bypass",
    });
    expect(postSpy).toHaveBeenCalledWith(
      "cukii/setBrokerPreferences",
      expect.objectContaining({
        brokerModel: "kimi-k3",
        brokerPermissionMode: "bypass",
      }),
    );
  });

  it("opens the Claude-style command menu and keeps broker controls", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const store = setupStore({ ideMessenger: mockIdeMessenger });
    store.dispatch({ type: "session/setBrokerModel", payload: "opus-5" });
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
      store,
    });

    await user.click(await getElementByTestId("broker-menu-button"));
    expect(await getElementByText("Clear conversation")).toBeDefined();
    const switchModel = await getElementByText("Switch model…");
    const switchModelText = switchModel.closest("button")?.textContent ?? "";
    expect(switchModelText.length).toBeGreaterThan("Switch model…".length);
    expect(switchModelText).not.toContain("·");
    expect(document.body.textContent).toContain("Thinking");
    expect(document.body.textContent).toContain("Manage accounts…");

    const effort = await getElementByTestId("cukii-effort-slider");
    effort.focus();
    await user.keyboard("{ArrowLeft}");
    expect(store.getState().session.brokerEffort).toBe("medium");
    expect(await getElementByText("(Medium)")).toBeDefined();
  });

  it.each(["not_authenticated", "board_unavailable", "unreachable"] as const)(
    "hides Report an issue when YouGile capability is %s",
    async (reason) => {
      const mockIdeMessenger = new MockIdeMessenger();
      mockIdeMessenger.responses["cukii/getIssueReportCapability"] = {
        available: false,
        reason,
      };
      const { user } = await renderWithProviders(<InputToolbar {...props} />, {
        mockIdeMessenger,
      });

      await user.click(await getElementByTestId("broker-menu-button"));
      await waitFor(() =>
        expect(document.body.textContent).toContain("Manage accounts…"),
      );
      expect(document.body.textContent).not.toContain("Report an issue…");
    },
  );

  it("retries a transient unreachable issue capability without opening Accounts", async () => {
    vi.useFakeTimers();
    try {
      const mockIdeMessenger = new MockIdeMessenger();
      let capabilityRequests = 0;
      mockIdeMessenger.responseHandlers["cukii/getIssueReportCapability"] =
        async () => {
          capabilityRequests += 1;
          return capabilityRequests === 1
            ? { available: false, reason: "unreachable" as const }
            : { available: true, reason: "available" as const };
        };

      await renderWithProviders(<InputToolbar {...props} />, {
        mockIdeMessenger,
      });
      await act(async () => undefined);
      expect(capabilityRequests).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(capabilityRequests).toBe(2);

      fireEvent.click(
        document.querySelector<HTMLElement>(
          '[data-testid="broker-menu-button"]',
        )!,
      );
      await act(async () => undefined);
      expect(
        document.querySelector('[data-testid="cukii-report-issue-menu-item"]'),
      ).not.toBeNull();
      expect(document.body.textContent).not.toContain("Accounts");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows Report an issue last from the prefetched board capability", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    const composerClick = vi.fn();
    const capabilityRequests: Array<{ force?: boolean } | undefined> = [];
    mockIdeMessenger.responseHandlers["cukii/getIssueReportCapability"] =
      async (input) => {
        capabilityRequests.push(input);
        return {
          available: true,
          reason: "available",
          accountLabel: "tester@example.com",
        };
      };
    const { user } = await renderWithProviders(
      <div onClick={composerClick}>
        <InputToolbar {...props} />
      </div>,
      { mockIdeMessenger },
    );

    await waitFor(() => expect(capabilityRequests).toHaveLength(1));
    await user.click(await getElementByTestId("broker-menu-button"));
    const report = await getElementByTestId("cukii-report-issue-menu-item");
    const menu = await getElementByTestId("cukii-slash-menu");
    const actions = [
      ...menu.querySelectorAll<HTMLElement>("[data-cukii-command-action]"),
    ];
    expect(report.textContent).toBe("Report an issue…");
    expect(actions.at(-1)).toBe(report);
    expect(
      actions.findIndex(
        (action) =>
          action.getAttribute("data-cukii-command-action") ===
          "Manage accounts",
      ),
    ).toBe(actions.length - 2);
    expect(capabilityRequests).toEqual([{ force: false }]);

    composerClick.mockClear();
    await user.click(report);
    expect(composerClick).not.toHaveBeenCalled();
    expect(await getElementByText("Report an issue")).toBeDefined();
    expect(
      document.querySelector('[data-testid="cukii-slash-menu"]'),
    ).toBeNull();

    // Closing the Headless UI popover must finish before the report dialog
    // claims focus. Otherwise the popover's deferred focus restoration steals
    // focus from every field (and closes a native select as soon as it opens).
    const title = document.querySelector<HTMLInputElement>(
      'input[placeholder="A short description of the problem"]',
    );
    const severity = document.querySelector<HTMLSelectElement>(
      ".cukii-report-field select",
    );
    expect(title).not.toBeNull();
    expect(severity).not.toBeNull();
    await waitFor(() => expect(title).toHaveFocus());
    await user.click(severity!);
    expect(severity).toHaveFocus();
    expect(composerClick).not.toHaveBeenCalled();
    expect(document.querySelector(".cukii-report-overlay")).not.toBeNull();
    await user.click(title!);
    expect(title).toHaveFocus();
    expect(composerClick).not.toHaveBeenCalled();
  });

  it("never inserts or removes Report an issue while the menu is open", async () => {
    const mockIdeMessenger = new MockIdeMessenger();
    let available = true;
    const capabilityRequests: Array<{ force?: boolean } | undefined> = [];
    mockIdeMessenger.responseHandlers["cukii/getIssueReportCapability"] =
      async (input) => {
        capabilityRequests.push(input);
        return available
          ? { available: true, reason: "available" }
          : { available: false, reason: "board_unavailable" };
      };
    const { user } = await renderWithProviders(<InputToolbar {...props} />, {
      mockIdeMessenger,
    });

    await waitFor(() => expect(capabilityRequests).toHaveLength(1));
    await user.click(await getElementByTestId("broker-menu-button"));
    expect(
      await getElementByTestId("cukii-report-issue-menu-item"),
    ).toBeDefined();

    available = false;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(capabilityRequests).toHaveLength(2));
    // The refreshed capability is unavailable, but the already open menu is
    // immutable and therefore cannot jump underneath the pointer.
    expect(
      document.querySelector('[data-testid="cukii-report-issue-menu-item"]'),
    ).not.toBeNull();

    await user.keyboard("{Escape}");
    await user.click(await getElementByTestId("broker-menu-button"));
    expect(
      document.querySelector('[data-testid="cukii-report-issue-menu-item"]'),
    ).toBeNull();
  });

  it("keeps the slash panel as a bounded overlay for narrow and long-label layouts", async () => {
    const { user } = await renderWithProviders(<InputToolbar {...props} />);

    await user.click(await getElementByTestId("broker-menu-button"));
    const menu = await getElementByTestId("cukii-slash-menu");
    const panel = menu.parentElement;
    expect(panel).toHaveClass("cukii-command-menu");
    expect(panel?.className).toContain("absolute");
    // The command menu's left edge must sit flush with the attach menu's edge:
    // the attach panel anchors left-0, while the command launcher sits one
    // button-width (28px) to the right, so the panel shifts back by exactly
    // that amount. A different value reintroduces the pixel drift vs the "+".
    expect(panel?.className).toContain("left-[-28px]");
    expect(panel?.className).not.toContain("w-[calc(100vw-38px)]");
    expect(
      menu.querySelector('[data-testid="broker-switch-model"] span'),
    ).toHaveClass("truncate");

    // Application CSS is not mounted by this jsdom harness.  Keep the
    // viewport contract explicit: the panel is capped at Claude-like 360px,
    // leaves gutters at 320px, and cannot force a horizontal document scroll.
    const css = canonicalCss();
    expect(css).toContain(".cukii-command-menu {");
    expect(css).toContain("width: min(360px, calc(100vw - 16px)) !important;");
    expect(css).toContain("max-width: calc(100vw - 16px) !important;");
    expect(css).toContain("min-width: 0 !important;");
    // The composer-edge offset must stay constant; the old viewport-scaled
    // left pushed the panel past the left border on narrow screens.
    expect(css).not.toMatch(/\.cukii-command-menu[^}]*left:\s*calc\([^)]*vw/);
  });

  it("has shared ordered command sections and removes unsupported Rewind", async () => {
    const { user } = await renderWithProviders(<InputToolbar {...props} />);
    await user.click(await getElementByTestId("broker-menu-button"));
    const menu = await getElementByTestId("cukii-slash-menu");
    const headers = [...menu.querySelectorAll("[data-command-section]")];
    expect(headers.map((header) => header.textContent)).toEqual([
      "Context",
      "Model",
    ]);
    expect(headers[0].previousElementSibling).not.toHaveAttribute(
      "data-testid",
      "cukii-command-section-divider",
    );
    const dividers = menu.querySelectorAll(
      '[data-testid="cukii-command-section-divider"]',
    );
    expect(dividers).toHaveLength(1);
    expect(dividers[0].nextElementSibling).toBe(headers[1]);
    expect(headers[0]).toHaveClass("cukii-command-section-header");
    expect(headers[1]).toHaveClass("cukii-command-section-header");
    expect(dividers[0]).toHaveClass("cukii-command-section-divider");
    expect(menu.textContent).not.toContain("Rewind");

    const filter = menu.querySelector<HTMLInputElement>(
      'input[placeholder="Filter actions..."]',
    );
    expect(filter).not.toBeNull();
    await user.type(filter!, "Rewind");
    expect(
      menu.querySelector('[data-cukii-command-action="Rewind"]'),
    ).toBeNull();
  });

  it("uses one blue active row for mouse and roving keyboard selection", async () => {
    document.documentElement.style.setProperty(
      "--vscode-list-activeSelectionBackground",
      "#04395e",
    );
    document.documentElement.style.setProperty(
      "--vscode-list-activeSelectionForeground",
      "#ffffff",
    );
    const { user } = await renderWithProviders(<InputToolbar {...props} />);
    await user.click(await getElementByTestId("broker-menu-button"));
    const menu = await getElementByTestId("cukii-slash-menu");
    const filter = menu.querySelector<HTMLInputElement>(
      'input[placeholder="Filter actions..."]',
    )!;
    expect(menu.querySelector(".cukii-command-menu-item-active")).toBeNull();

    fireEvent.keyDown(filter, { key: "ArrowDown" });
    const first = menu.querySelector<HTMLButtonElement>(
      'button[data-cukii-command-action="Attach file"]',
    )!;
    expect(document.activeElement).toBe(first);
    expect(first).toHaveClass("cukii-command-menu-item-active");
    // The component carries the active semantic class; assert the canonical
    // stylesheet rule because this harness does not mount application CSS.
    const css = canonicalCss();
    expect(first).toHaveClass("cukii-command-menu-action");
    expect(css).toContain(".cukii-menu-item.cukii-command-menu-item-active,");
    expect(css).toContain("--vscode-list-activeSelectionBackground,");
    expect(css).toContain(
      "color: var(--vscode-list-activeSelectionForeground, #ffffff) !important;",
    );
    expect(css).toContain(
      ".cukii-menu-item.cukii-command-menu-action:hover:not(:disabled),",
    );
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute(
      "data-cukii-command-action",
      "Mention file from this project",
    );

    const clear = menu.querySelector<HTMLButtonElement>(
      'button[data-cukii-command-action="Clear conversation"]',
    )!;
    fireEvent.mouseEnter(clear);
    expect(clear).toHaveClass("cukii-command-menu-item-active");
    expect(
      menu.querySelectorAll(".cukii-command-menu-item-active"),
    ).toHaveLength(1);
    expect(
      menu.querySelector('[data-cukii-command-action="Effort"]'),
    ).toBeNull();
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(
      document.querySelector('[data-testid="cukii-slash-menu"]'),
    ).toBeNull();
    document.documentElement.style.removeProperty(
      "--vscode-list-activeSelectionBackground",
    );
    document.documentElement.style.removeProperty(
      "--vscode-list-activeSelectionForeground",
    );
  });
});
