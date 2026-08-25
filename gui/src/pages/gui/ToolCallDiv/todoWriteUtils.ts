import { BuiltInToolNames } from "core/tools/builtIn";
import { parseTodoList } from "core/tools/todoWriteParse";

export { parseTodoList };

export function isTodoWriteToolCall(functionName: string | undefined): boolean {
  return functionName === BuiltInToolNames.TodoWrite;
}
