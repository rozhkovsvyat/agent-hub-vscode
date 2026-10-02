import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, updateConfig } from "../../../redux/slices/configSlice";
import { setupStore } from "../../../redux/store";
import { MockIdeMessenger } from "../../../context/MockIdeMessenger";
import { renderWithProviders } from "../../../util/test/render";
import { StepContainerPreToolbar } from "./index";

async function renderToolbar(withApplyModel: boolean) {
  const mockIdeMessenger = new MockIdeMessenger();
  const store = setupStore({ ideMessenger: mockIdeMessenger });
  await renderWithProviders(
    <StepContainerPreToolbar
      codeBlockContent={"print('hi')"}
      language="python"
      codeBlockIndex={0}
      isLastCodeblock
      codeBlockStreamId="cb"
    >
      <pre>print('hi')</pre>
    </StepContainerPreToolbar>,
    { store, mockIdeMessenger },
  );
  // Set the config after mount: the mock messenger's initial config load
  // would otherwise replace it.
  await act(async () => {
    store.dispatch(
      updateConfig({
        ...EMPTY_CONFIG,
        selectedModelByRole: {
          ...EMPTY_CONFIG.selectedModelByRole,
          ...(withApplyModel
            ? { apply: { title: "m", model: "m", provider: "openai" } as any }
            : {}),
        },
      } as any),
    );
  });
}

describe("code block Apply needs a Continue apply/chat model", () => {
  it("hides Apply for a Cukii Chat user with no Continue model", async () => {
    await renderToolbar(false);
    expect(screen.queryByTestId("codeblock-toolbar-apply")).toBeNull();
  });

  it("keeps Apply when such a model is configured (control)", async () => {
    await renderToolbar(true);
    expect(await screen.findByTestId("codeblock-toolbar-apply")).toBeTruthy();
  });
});
