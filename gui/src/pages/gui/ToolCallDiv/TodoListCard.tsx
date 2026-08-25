import { CheckIcon } from "@heroicons/react/24/outline";
import { TodoItem } from "core/tools/todoWriteParse";
import { parseTodoList } from "./todoWriteUtils";

interface TodoListCardProps {
  parsedArgs: Record<string, unknown> | undefined;
}

function TodoCheckbox({ status }: { status: TodoItem["status"] }) {
  const baseClass =
    "flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border";

  if (status === "completed") {
    return (
      <span
        className={`${baseClass} border-success bg-success/20 text-success`}
        aria-hidden
      >
        <CheckIcon className="h-2.5 w-2.5" />
      </span>
    );
  }

  if (status === "in_progress") {
    return (
      <span className={`${baseClass} border-warning bg-warning/20`} aria-hidden>
        <span className="bg-warning h-1.5 w-1.5 rounded-full" />
      </span>
    );
  }

  return (
    <span className={`${baseClass} border-description-muted`} aria-hidden />
  );
}

function TodoRow({ item }: { item: TodoItem }) {
  const rowClass =
    item.status === "completed"
      ? "text-description-muted line-through"
      : item.status === "in_progress"
        ? "text-foreground font-medium"
        : "text-description";

  return (
    <li className="flex min-w-0 items-start gap-2 py-0.5">
      <TodoCheckbox status={item.status} />
      <span className={`min-w-0 flex-1 text-xs ${rowClass}`}>
        {item.content}
      </span>
    </li>
  );
}

export function TodoListCard({ parsedArgs }: TodoListCardProps) {
  const todos = parseTodoList(parsedArgs);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const total = todos.length;

  return (
    <div
      className="border-border bg-editor rounded-md border px-2.5 py-2"
      data-testid="todo-list-card"
    >
      <div
        className="text-description-muted text-2xs mb-1.5 font-medium"
        data-testid="todo-list-header"
      >
        {completed}/{total} done
      </div>
      {todos.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {todos.map((item) => (
            <TodoRow key={item.id} item={item} />
          ))}
        </ul>
      ) : (
        <div className="text-description-muted text-xs italic">No todos</div>
      )}
    </div>
  );
}
