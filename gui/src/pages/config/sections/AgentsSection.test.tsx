import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { createMockStore } from "../../../util/test/mockStore";
import { AgentsSection } from "./AgentsSection";

describe("AgentsSection", () => {
  it("presents Cursor as a native Windows agent", () => {
    const { mockIdeMessenger } = createMockStore({});

    render(
      <IdeMessengerContext.Provider value={mockIdeMessenger}>
        <AgentsSection />
      </IdeMessengerContext.Provider>,
    );

    expect(screen.getByText("Native Cursor Agent for Windows")).toBeVisible();
    expect(screen.queryByText(/Cursor Agent via WSL/i)).not.toBeInTheDocument();
  });
});
