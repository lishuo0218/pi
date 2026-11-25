// Todo store: the current session's checklist from the todo tool. Rebuilt
// from todo tool result details on tool_execution_end and from hydrated
// toolResult messages on session switch. One checklist per task: the tool
// replaces it wholesale when the agent starts a new task.
import type { TodoTask } from "./protocol";

export class TodoStore {
  tasks: TodoTask[] = [];
  version = 0;
  private subscribers = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.subscribers) fn();
  }

  /**
   * Replace the checklist with the tasks carried in a todo tool result's
   * `details`. Trust boundary: the bridge wire. Anything that is not a
   * non-empty task array with string text leaves the store untouched.
   */
  setFromDetails(details: Record<string, unknown> | undefined): void {
    const tasks = parseTodoDetails(details);
    if (!tasks) return;
    this.tasks = tasks;
    this.emit();
  }

  clear(): void {
    if (this.tasks.length === 0) return;
    this.tasks = [];
    this.emit();
  }
}

/** Parse todo tool `details` into tasks, or null when it does not match. */
function parseTodoDetails(details: Record<string, unknown> | undefined): TodoTask[] | null {
  const raw = details?.tasks;
  if (!Array.isArray(raw)) return null;
  const tasks: TodoTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { text, done } = item as { text?: unknown; done?: unknown };
    if (typeof text !== "string" || typeof done !== "boolean") return null;
    tasks.push({ text, done });
  }
  return tasks;
}
