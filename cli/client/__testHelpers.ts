// packages/cli/client/__testHelpers.ts
//
// CLI executor 测试用的轻量内存 store 实现（避免测试依赖文件 I/O）。
// 生产代码用 fileSystemStores.ts（落本地文件）；测试用这里的内存版。
import type {
  AgentRunTodoRecord,
  AgentRunTodoStore,
} from "../../ai/tools/agent/agentRunTodo";

export function createInMemoryTodoStore(): AgentRunTodoStore & {
  putTodo: (todo: AgentRunTodoRecord) => Promise<void>;
} {
  const todos = new Map<string, AgentRunTodoRecord>();
  return {
    async getTodo(id: string): Promise<AgentRunTodoRecord | null> {
      return todos.get(id) ?? null;
    },
    async listTodos(): Promise<AgentRunTodoRecord[]> {
      return [...todos.values()];
    },
    async saveTodo(todo: AgentRunTodoRecord): Promise<void> {
      todos.set(todo.id, todo);
    },
    async putTodo(todo: AgentRunTodoRecord): Promise<void> {
      todos.set(todo.id, todo);
    },
    async deleteTodo(id: string): Promise<boolean> {
      const existed = todos.has(id);
      todos.delete(id);
      return existed;
    },
  };
}
