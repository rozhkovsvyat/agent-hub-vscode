export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

const VALID_STATUSES = new Set<TodoStatus>([
  "pending",
  "in_progress",
  "completed",
]);

function normalizeStatus(status: unknown): TodoStatus {
  if (typeof status === "string" && VALID_STATUSES.has(status as TodoStatus)) {
    return status as TodoStatus;
  }
  return "pending";
}

function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : "";
  const content = typeof item.content === "string" ? item.content : "";

  if (!id && !content) {
    return null;
  }

  return {
    id: id || content,
    content,
    status: normalizeStatus(item.status),
  };
}

function parseTodosValue(todos: unknown): unknown[] {
  if (Array.isArray(todos)) {
    return todos;
  }

  if (typeof todos === "string") {
    try {
      const parsed = JSON.parse(todos);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

export function parseTodoList(
  parsedArgs: Record<string, unknown> | undefined,
): TodoItem[] {
  const todos = parseTodosValue(parsedArgs?.todos);
  return todos
    .map(normalizeTodoItem)
    .filter((item): item is TodoItem => item !== null);
}
