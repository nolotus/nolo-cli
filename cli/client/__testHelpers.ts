// packages/cli/client/__testHelpers.ts
//
// CLI executor 测试用的轻量内存 store 实现（避免测试依赖文件 I/O）。
// 生产代码用 fileSystemStores.ts（落本地文件）；测试用这里的内存版。
import type { TodoRecord, TodoStatus, TodoStore } from "../../ai/tools/agent/runtimeTodo";

export function createInMemoryTodoStore(): TodoStore {
  const todos = new Map<string, TodoRecord>();
  return {
    async getTodo(id: string): Promise<TodoRecord | undefined> {
      return todos.get(id);
    },
    async listTodos(filter?: { statuses?: TodoStatus[] }): Promise<TodoRecord[]> {
      const all = [...todos.values()];
      if (!filter?.statuses || filter.statuses.length === 0) return all;
      const wanted = new Set(filter.statuses);
      return all.filter((t) => wanted.has(t.status));
    },
    async putTodo(todo: TodoRecord): Promise<void> {
      todos.set(todo.id, todo);
    },
    async deleteTodo(id: string): Promise<void> {
      todos.delete(id);
    },
  };
}