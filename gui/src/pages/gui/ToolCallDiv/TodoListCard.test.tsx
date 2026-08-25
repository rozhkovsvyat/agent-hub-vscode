import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TodoListCard } from "./TodoListCard";

describe("TodoListCard", () => {
  it("renders pending, in_progress, and completed items with counts", () => {
    render(
      <TodoListCard
        parsedArgs={{
          todos: [
            { id: "1", content: "Pending task", status: "pending" },
            { id: "2", content: "Active task", status: "in_progress" },
            { id: "3", content: "Done task", status: "completed" },
          ],
        }}
      />,
    );

    expect(screen.getByTestId("todo-list-card")).toBeTruthy();
    expect(screen.getByTestId("todo-list-header").textContent).toBe("1/3 done");
    expect(screen.getByText("Pending task")).toBeTruthy();
    expect(screen.getByText("Active task")).toBeTruthy();
    expect(screen.getByText("Done task")).toBeTruthy();
  });

  it("parses todos from a JSON string", () => {
    render(
      <TodoListCard
        parsedArgs={{
          todos: JSON.stringify([
            { id: "1", content: "From JSON", status: "pending" },
          ]),
        }}
      />,
    );

    expect(screen.getByText("From JSON")).toBeTruthy();
    expect(screen.getByTestId("todo-list-header").textContent).toBe("0/1 done");
  });

  it("shows empty state for no todos", () => {
    render(<TodoListCard parsedArgs={{ todos: [] }} />);

    expect(screen.getByTestId("todo-list-card")).toBeTruthy();
    expect(screen.getByText("No todos")).toBeTruthy();
    expect(screen.getByTestId("todo-list-header").textContent).toBe("0/0 done");
  });
});
