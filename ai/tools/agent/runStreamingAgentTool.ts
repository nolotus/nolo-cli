// 路径: ai/tools/agent/runStreamingAgentTool.ts

/**
 * [Schema] 定义 'runStreamingAgent' 工具的结构，供 LLM 调用。
 *
 * 主要用于用户希望立刻看到回复的临时调用，无法后台运行。
 * 调用后 Agent 的输出会以流式方式实时呈现给用户，适合需要即时反馈的场景。
 *
 * 注意：
 * - 这里只是一个「数据工具」：返回要调用的 Agent 信息，不直接发起流式调用。
 * - 真正的 streamAgentChatTurn 在 chat/messages/toolThunks.ts 的 handleToolCalls 里触发，
 *   这样就可以做到：
 *   1）先写标准的 tool 消息（符合 OpenAI 消息格式）
 *   2）再启动一个生命周期独立的 streamAgentChatTurn
 */
export const runStreamingAgentFunctionSchema = {
  name: "runStreamingAgent",
  description:
    "准备调用一个指定的 Agent (智能代理)，并以流式方式处理用户输入。该工具本身只返回要调用的 Agent 信息，实际流式调用由系统在工具执行后发起。",
  parameters: {
    type: "object",
    properties: {
      agentKey: {
        type: "string",
        description: "要运行的 Agent 的唯一标识符 (Key)。",
      },
      userInput: {
        type: "string",
        description: "要发送给该 Agent 的用户输入或问题。",
      },
      serverBase: {
        type: "string",
        description:
          "可选。目标 Agent 所在的 nolo server origin，例如 Windows 机器通过 Cloudflare 暴露的 https://win.example.com。" +
          "跨域目标必须由服务端 AGENT_TOOL_ALLOWED_SERVER_BASES 明确放行。" +
          "如果目标 Agent 记录声明了 delegation.serverBase / runtimeServerBase，服务端会在未显式传入时自动路由。",
      },
    },
    required: ["agentKey", "userInput"],
  },
};

/**
 * [Executor] 'runStreamingAgent' 工具执行函数。
 *
 * - 不直接发起 streamAgentChatTurn。
 * - 返回 { agentKey, userInput }，供上层在写完 tool 消息后再启动真正的流式 Agent 调用。
 */
export async function runStreamingAgentFunc(
  args: { agentKey: string; userInput: string; serverBase?: string },
  _thunkApi: any,
  _context?: { parentMessageId?: string; signal?: AbortSignal; toolRunId?: string; agentKey?: string; userInput?: string }
): Promise<{ rawData: any; displayData: string }> {
  const { agentKey, userInput, serverBase } = args;

  if (!agentKey) {
    throw new Error("调用 'runStreamingAgent' 失败：缺少 'agentKey' 参数。");
  }
  if (!userInput) {
    throw new Error("调用 'runStreamingAgent' 失败：缺少 'userInput' 参数。");
  }

  // 这里只返回调用参数，由 handleToolCalls 决定何时真正发起流式调用
  const rawData = {
    agentKey,
    userInput,
    ...(serverBase ? { serverBase } : {}),
  };

  const displayData = `将调用 Agent(${agentKey}) 执行一轮流式对话`;

  return { rawData, displayData };
}
