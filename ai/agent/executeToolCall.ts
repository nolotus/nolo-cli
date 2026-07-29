// packages/ai/agent/executeToolCall.ts
//
// 提取自 runAgentClientLoop：非流式多轮循环中执行单次 tool_call 的公共逻辑。
// streamAgentChatTurn 走 sendOpenAICompletionsRequest → toolThunks，不使用此函数。

import { findToolExecutor } from "../tools";
import { getToolResultErrorData } from "../tools/toolResultError";

interface ToolCall {
  id: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

/**
 * 执行单次 tool_call，返回工具结果字符串（供追加到 messages）。
 *
 * @param tc            LLM 返回的单个 tool_call 对象
 * @param thunkApi      Redux thunkApi（含 dispatch / getState）
 * @param parentMessageId 父消息 ID（关联上下文）
 */
export async function executeToolCall(
  tc: ToolCall,
  thunkApi: any,
  context?: { parentMessageId?: string; agentKey?: string }
): Promise<string> {
  const toolName: string = tc.function?.name ?? "";
  const toolArgs = (() => {
    try {
      return JSON.parse(tc.function?.arguments ?? "{}");
    } catch {
      return {};
    }
  })();

  try {
    const toolDefinition = findToolExecutor(toolName);
    if (!toolDefinition) {
      return `[工具 "${toolName}" 未找到]`;
    }
    const result = await toolDefinition.executor(toolArgs, thunkApi, {
      parentMessageId: context?.parentMessageId ?? "",
    });
    // executor 返回 { rawData, displayData? } 或直接返回字符串
    const raw = result?.rawData ?? result;
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch (err: any) {
    console.error(`[executeToolCall] tool "${toolName}" 执行失败:`, err);
    const structured = getToolResultErrorData(err);
    if (structured?.rawData !== undefined) {
      const raw = structured.rawData;
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    }
    return `[工具 "${toolName}" 执行失败: ${err?.message ?? err}]`;
  }
}
