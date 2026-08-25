import { expect, test } from "vitest";
import { parseTodoList } from "../todoWriteParse";
import { todoWriteImpl } from "./todoWrite";

test("parseTodoList accepts todos as an array", () => {
  const todos = parseTodoList({
    todos: [
      { id: "1", content: "First", status: "pending" },
      { id: "2", content: "Second", status: "in_progress" },
    ],
  });

  expect(todos).toEqual([
    { id: "1", content: "First", status: "pending" },
    { id: "2", content: "Second", status: "in_progress" },
  ]);
});

test("parseTodoList accepts todos as a JSON string", () => {
  const todos = parseTodoList({
    todos: JSON.stringify([{ id: "a", content: "Alpha", status: "completed" }]),
  });

  expect(todos).toEqual([{ id: "a", content: "Alpha", status: "completed" }]);
});

test("parseTodoList returns empty array for missing todos", () => {
  expect(parseTodoList(undefined)).toEqual([]);
  expect(parseTodoList({})).toEqual([]);
  expect(parseTodoList({ todos: "not-json" })).toEqual([]);
});

test("parseTodoList defaults invalid status to pending", () => {
  const todos = parseTodoList({
    todos: [{ id: "1", content: "Task", status: "invalid" }],
  });

  expect(todos).toEqual([{ id: "1", content: "Task", status: "pending" }]);
});

test("todoWriteImpl returns summary ContextItem", async () => {
  const result = await todoWriteImpl(
    {
      todos: [
        { id: "1", content: "Done task", status: "completed" },
        { id: "2", content: "Active task", status: "in_progress" },
        { id: "3", content: "Later task", status: "pending" },
      ],
    },
    {} as any,
  );

  expect(result).toHaveLength(1);
  expect(result[0].name).toBe("Todo");
  expect(result[0].description).toBe("1/3 done");
  expect(result[0].content).toContain("Todo list (1/3 done)");
  expect(result[0].content).toContain("[x] Done task");
  expect(result[0].content).toContain("[>] Active task");
  expect(result[0].content).toContain("[ ] Later task");
});

test("todoWriteImpl handles empty todos", async () => {
  const result = await todoWriteImpl({ todos: [] }, {} as any);

  expect(result[0].description).toBe("0/0 done");
  expect(result[0].content).toContain("(empty)");
});
