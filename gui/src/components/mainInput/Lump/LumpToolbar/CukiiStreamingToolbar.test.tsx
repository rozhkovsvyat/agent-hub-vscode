import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CukiiWaitingReceipt } from "./CukiiStreamingToolbar";

describe("CukiiWaitingReceipt", () => {
  it("renders an explicit native wait as a static accessible status", () => {
    render(
      <CukiiWaitingReceipt
        wait={{
          condition: "Sleeping for 12 seconds",
          deadline: "2026-08-31T12:00:12.000Z",
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Cukii is waiting — Sleeping for 12 seconds · until 2026-08-31T12:00:12.000Z",
    );
    expect(screen.queryByTestId("cukii-crumbs")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("cukii-streaming-toolbar"),
    ).not.toBeInTheDocument();
  });
});
