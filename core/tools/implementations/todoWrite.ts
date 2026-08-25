import { ToolImpl } from ".";
import { parseTodoList } from "../todoWriteParse";

function statusMarker(status: string): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[>]";
    default:
      return "[ ]";
  }
}

export const todoWriteImpl: ToolImpl = async (args) => {
  const todos = parseTodoList(args);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const total = todos.length;

  const lines =
    todos.length > 0
      ? todos.map((todo) => `${statusMarker(todo.status)} ${todo.content}`)
      : ["(empty)"];

  const content = `Todo list (${completed}/${total} done):\n${lines.join("\n")}`;

  return [
    {
      name: "Todo",
      description: `${completed}/${total} done`,
      content,
    },
  ];
};
