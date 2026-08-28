import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CukiiMark } from "./CukiiMark";

describe("CukiiMark", () => {
  it("renders the activity mark at the requested size", () => {
    render(<CukiiMark size={46} />);
    const mark = screen.getByRole("img", { name: "Cukii" });
    expect(mark).toHaveClass("cukii-mark");
    expect(mark).toHaveStyle({ width: "46px", height: "46px" });
  });
});
