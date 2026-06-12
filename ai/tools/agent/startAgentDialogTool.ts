export const startAgentDialogFunctionSchema = {
  name: "startAgentDialog",
  description:
    "启动一个子 Agent dialog 并立即返回 childDialogId。用于通用 agent 派发/交接，不等待子 Agent 完成，也不替调用方决定任务状态。",
  parameters: {
    type: "object",
    properties: {
      targetAgentKey: {
        type: "string",
        description: "要启动的目标 Agent key。",
      },
      message: {
        type: "string",
        description: "发送给目标 Agent 的自然语言任务或上下文。",
      },
      parentDialogId: {
        type: "string",
        description: "可选。父 dialogId；未提供时使用当前 dialogId。",
      },
      subjectRefs: {
        type: "array",
        description:
          "可选。与本次子 dialog 相关的业务对象引用，保持行业中立。交接任务行时传 {kind:\"table-row\", id: rowDbKey, role:\"task\"}；服务端会继承父 dialog/runtimeContext 已有的 subjectRefs。",
        items: {
          type: "object",
          properties: {
            kind: { type: "string" },
            id: { type: "string" },
            role: { type: "string" },
          },
          required: ["kind", "id"],
        },
      },
      idempotencyKey: {
        type: "string",
        description: "可选。调用方用于去重的稳定 key；当前版本仅透传给运行上下文。",
      },
      serverBase: {
        type: "string",
        description:
          "可选。目标 Agent 所在的 nolo server origin；跨域目标必须由服务端 AGENT_TOOL_ALLOWED_SERVER_BASES 放行。",
      },
      timeoutMs: {
        type: "number",
        description: "可选。子 Agent background run 的执行超时预算（毫秒）。",
      },
    },
    required: ["targetAgentKey", "message"],
  },
};

export async function startAgentDialogFunc(): Promise<never> {
  throw new Error("startAgentDialog is a server-side agent tool. Use it through /api/agent/run.");
}
