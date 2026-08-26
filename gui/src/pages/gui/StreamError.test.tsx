import { act, screen } from "@testing-library/react";
import { addAndSelectChatModel } from "../../util/test/config";
import { renderWithProviders } from "../../util/test/render";
import { setBrokerModel, setMode } from "../../redux/slices/sessionSlice";
import StreamErrorDialog from "./StreamError";

test("broker image overflow is attributed to Grok, not DeepSeek", async () => {
  const { store, ideMessenger } = await renderWithProviders(
    <StreamErrorDialog
      error={
        new Error(
          "Grok image attachment is too large for the Windows native bridge. Attach a smaller image.",
        )
      }
    />,
  );

  await act(async () => {
    store.dispatch(setMode("broker"));
    store.dispatch(setBrokerModel("grok-4-6"));
    addAndSelectChatModel(store, ideMessenger, {
      model: "deepseek-chat",
      provider: "deepseek",
      title: "DeepSeek V4 Pro (AI Gateway)",
      underlyingProviderName: "deepseek",
    });
  });

  const dialog = screen.getByText(
    /error handling the response from/i,
  ).parentElement;
  expect(dialog?.textContent).toMatch(/Grok 4\.6 \(Cukii Broker\)/);
  expect(dialog?.textContent).not.toMatch(/DeepSeek/);
});
