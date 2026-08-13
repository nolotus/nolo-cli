import { describe, expect, it } from "bun:test";
import { createFileSystemTodoStore } from "./fileSystemStores";

describe("fileSystemStores - createFileSystemTodoStore migration", () => {
  it("automatically migrates old todos.json to agent_run_todos.json when new file is absent", async () => {
    const memoryFiles: Record<string, string> = {
      "/mock/nolo/todos.json": JSON.stringify({
        todos: [
          {
            id: "old-1",
            title: "Legacy task",
            status: "blocked",
            runIds: ["run-legacy"],
            specPath: "/tmp/spec.md",
            createdAt: "2026-08-01T00:00:00Z",
            updatedAt: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    };

    const fakeFs: any = {
      existsSync: (path: string) => Boolean(memoryFiles[path]),
      readFileSync: (path: string) => memoryFiles[path] || "",
      writeFileSync: (path: string, content: string) => {
        memoryFiles[path] = content;
      },
      mkdirSync: () => {},
    };

    const store = createFileSystemTodoStore({
      env: { NOLO_HOME: "/mock/nolo" },
      homedir: () => "/mock/home",
      fs: fakeFs,
    });

    const todos = await store.listTodos();
    expect(todos.length).toBe(1);
    expect(todos[0].id).toBe("old-1");
    expect(todos[0].title).toBe("Legacy task");
    // blocked -> failed
    expect(todos[0].status).toBe("failed");

    // Check that new agent_run_todos.json was generated
    expect(memoryFiles["/mock/nolo/agent_run_todos.json"]).toBeDefined();
    const savedNewData = JSON.parse(memoryFiles["/mock/nolo/agent_run_todos.json"]);
    expect(savedNewData.todos.length).toBe(1);
    expect(savedNewData.todos[0].id).toBe("old-1");
  });
});
