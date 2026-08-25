import { Tool } from "../..";

import { BUILT_IN_GROUP_NAME, BuiltInToolNames } from "../builtIn";

export const todoWriteTool: Tool = {
  type: "function",
  displayTitle: "Todo",
  wouldLikeTo: "update the todo list",
  isCurrently: "updating the todo list",
  hasAlready: "updated the todo list",
  readonly: true,
  isInstant: true,
  group: BUILT_IN_GROUP_NAME,
  function: {
    name: BuiltInToolNames.TodoWrite,
    description:
      "Replace the current todo list with this exact list (not a merge). Keep 1 in_progress item when possible. Use for multi-step work.",
    parameters: {
      type: "object",
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          description: "The todo items to set",
          items: {
            type: "object",
            required: ["id", "content", "status"],
            properties: {
              id: {
                type: "string",
                description: "Unique identifier for the todo item",
              },
              content: {
                type: "string",
                description: "The todo item description",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "The todo item status",
              },
            },
          },
        },
      },
    },
  },
  defaultToolPolicy: "allowedWithoutPermission",
  systemMessageDescription: {
    prefix: `To update the agent todo list, call the ${BuiltInToolNames.TodoWrite} tool with "todos". This replaces the entire list (not a merge). Keep one item in_progress when possible. For example:`,
    exampleArgs: [
      [
        "todos",
        '[{"id":"1","content":"First task","status":"in_progress"},{"id":"2","content":"Second task","status":"pending"}]',
      ],
    ],
  },
};
