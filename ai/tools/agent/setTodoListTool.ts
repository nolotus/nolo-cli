/**
 * ChatTodo 工具：setTodoList
 *
 * 一个 Kimi 式 ChatTodo 工具，参数为 todos 数组（title + pending/in_progress/done）。
 * 每次整体替换当前 dialog 的列表。
 * 工具结果返回结构化 displayData 和 rawData，支持持久化和前端 TodoCard 渲染。
 */

export interface TodoItem {
  title: string;
  status: "pending" | "in_progress" | "done";
}

export interface SetTodoListArgs {
  todos: TodoItem[];
}

export const setTodoListFunctionSchema = {
  name: "setTodoList",
  description: "设置/整体更新当前对话的任务列表（Kimi 式 Todo 列表）。用于多步骤任务进度追踪与展示。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "完整的 Todo 任务列表（整体替换）",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "任务描述/标题",
            },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done"],
              description: "任务状态：pending(待处理), in_progress(进行中), done(已完成)",
            },
          },
          required: ["title", "status"],
        },
      },
    },
    required: ["todos"],
  },
};

export function formatTodoListDisplayData(todos: TodoItem[]): string {
  if (!todos || todos.length === 0) {
    return "📋 Todo 列表已清空";
  }

  const statusIcons: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    done: "✅",
  };

  const statusLabels: Record<string, string> = {
    pending: "待处理",
    in_progress: "进行中",
    done: "已完成",
  };

  const doneCount = todos.filter((t) => t.status === "done").length;
  const lines = [
    `📋 Todo 列表 (${doneCount}/${todos.length})`,
    ...todos.map(
      (t) =>
        `• ${statusIcons[t.status] ?? "•"} [${statusLabels[t.status] ?? t.status}] ${t.title}`
    ),
  ];

  return lines.join("\n");
}

export async function setTodoListFunc(
  args: SetTodoListArgs
): Promise<{ rawData: { todos: TodoItem[] }; displayData: string }> {
  const todos = Array.isArray(args?.todos) ? args.todos : [];

  const sanitizedTodos: TodoItem[] = todos.map((item) => {
    const title = typeof item?.title === "string" ? item.title.trim() : "Untitled Task";
    let status: TodoItem["status"] = "pending";
    if (item?.status === "in_progress") status = "in_progress";
    else if (item?.status === "done") status = "done";
    return { title, status };
  });

  const displayData = formatTodoListDisplayData(sanitizedTodos);

  return {
    rawData: { todos: sanitizedTodos },
    displayData,
  };
}

export const setTodoListTool = {
  schema: setTodoListFunctionSchema,
  executor: setTodoListFunc,
};
