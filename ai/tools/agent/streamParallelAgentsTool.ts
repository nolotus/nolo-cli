export const streamParallelAgentsFunctionSchema = {
  name: "streamParallelAgents",
  description:
    "并行调用多个 Agent，让它们分别以流式方式输出观点。适合多模型发散、评审团式讨论和多视角分析。",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "要并行交给多个 Agent 的任务描述。",
      },
      agents: {
        type: "array",
        description: "需要并行调用的 Agent 列表。",
        items: {
          type: "object",
          properties: {
            agentKey: {
              type: "string",
              description: "目标 Agent 的 dbKey。",
            },
            label: {
              type: "string",
              description: "可选：分支展示名称。",
            },
            branchId: {
              type: "string",
              description: "可选：分支稳定标识。",
            },
            serverBase: {
              type: "string",
              description:
                "可选：该 Agent 所在的 nolo server origin，例如 Windows 机器通过 Cloudflare 暴露的 https://win.example.com。" +
                "跨域目标必须由服务端 AGENT_TOOL_ALLOWED_SERVER_BASES 明确放行。" +
                "如果目标 Agent 记录声明了 delegation.serverBase / runtimeServerBase，服务端会在未显式传入时自动路由。",
            },
          },
          required: ["agentKey"],
        },
      },
      serverBase: {
        type: "string",
        description:
          "可选：默认目标 nolo server origin。agents[*].serverBase 会覆盖此值；目标 Agent 记录的 runtime 元数据可在未传值时自动补齐。",
      },
      timeoutMs: {
        type: "number",
        description:
          "可选：单个分支的超时时间（毫秒）。本地 CLI/machine agent 会把该值作为本次 connector 请求预算。",
      },
      budgetCredits: {
        type: "number",
        description:
          "可选：本轮并行调用可消耗的剩余预算（单位：积分 / credits）。结果会返回 spentCredits / remainingCredits / exhausted，供父 Agent 决定是否继续下一轮。",
      },
      returnMode: {
        type: "string",
        enum: ["handoff", "continue"],
        description:
          '可选：handoff 表示并行结果直接结束本轮并交给用户；continue 表示把分支结果留在上下文里，父 Agent 继续思考。',
      },
      displayMode: {
        type: "string",
        enum: ["folded", "inline"],
        description:
          '可选：inline 表示把完整分支回答直接作为当前对话里的普通消息展开。folded 已废弃，运行时会自动按 inline 处理。',
      },
    },
    required: ["task", "agents", "returnMode"],
  },
};

export async function streamParallelAgentsFunc(args: {
  task: string;
  agents: Array<{ agentKey: string; label?: string; branchId?: string; serverBase?: string }>;
  serverBase?: string;
  timeoutMs?: number;
  budgetCredits?: number;
  returnMode?: "handoff" | "continue";
  displayMode?: "folded" | "inline";
}) {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const agents = Array.isArray(args.agents) ? args.agents : [];
  const timeoutMs =
    typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : undefined;
  const budgetCredits =
    typeof args.budgetCredits === "number" &&
    Number.isFinite(args.budgetCredits) &&
    args.budgetCredits > 0
      ? Number(args.budgetCredits.toFixed(6))
      : undefined;
  const returnMode = args.returnMode === "continue" ? "continue" : "handoff";
  const displayMode = "inline";
  const serverBase =
    typeof args.serverBase === "string" && args.serverBase.trim()
      ? args.serverBase.trim()
      : undefined;

  if (!task) {
    throw new Error("streamParallelAgents: 缺少 task。");
  }
  if (agents.length === 0) {
    throw new Error("streamParallelAgents: 缺少 agents。");
  }

  return {
    rawData: {
      task,
      agents,
      ...(serverBase ? { serverBase } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(budgetCredits ? { budgetCredits } : {}),
      returnMode,
      displayMode,
    },
    displayData:
      returnMode === "continue"
        ? `将并行调用 ${agents.length} 个 Agent，并把结果返回给父 Agent 继续会商${budgetCredits ? `（预算 ${budgetCredits} 积分）` : ""}`
        : `将并行调用 ${agents.length} 个 Agent${budgetCredits ? `（预算 ${budgetCredits} 积分）` : ""}`,
  };
}
