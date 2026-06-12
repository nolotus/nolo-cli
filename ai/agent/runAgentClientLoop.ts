// packages/ai/agent/runAgentClientLoop.ts
//
// 客户端多轮 Agent 循环：复现服务端 runAgentLoop 的逻辑
// - 不支持 Response API（当前全部走 OpenAI Completions 格式）
// - 工具执行通过 executeToolCall 在客户端完成
// - 每轮：调 LLM → 有 tool_calls → 执行工具 → 追加 tool 消息 → 继续

import { RootState } from "../../app/store";
import { Message } from "../../app/types";
import { read } from "../../database/dbSlice";
import { fetchAgentContexts } from "../agent/fetchAgentContexts";
import { generateRequestBody } from "../llm/generateRequestBody";
import { getApiEndpoint } from "../llm/providers";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { selectCurrentToken } from "../../auth/authSlice";
import { performFetchRequest } from "../chat/fetchUtils";
import { executeToolCall } from "../agent/executeToolCall";
import { extractCustomId } from "../../core/prefix";
import { updateTokensAction } from "../../chat/dialog/actions/updateTokensAction";
import {
  recordConsecutiveToolFailure,
  type ToolFailureGuardState,
} from "../agent/toolFailureGuard";

export interface RunAgentClientLoopArgs {
  agentKey: string;
  content: any;
  parentMessageId?: string;
  billingDialogKey?: string;
}

export interface RunAgentClientLoopResult {
  content: string;
  toolCallCount: number;
}

/**
 * 客户端多轮 Agent 执行循环。
 *
 * 使用场景：callAgentTool 的 client 模式、runAgent thunk。
 * 不适合需要流式输出的场景（请用 runStreamingAgent）。
 */
export async function runAgentClientLoop(
  args: RunAgentClientLoopArgs,
  thunkApi: any
): Promise<RunAgentClientLoopResult> {
  const { agentKey, content, parentMessageId, billingDialogKey } = args;
  const { getState, dispatch } = thunkApi;
  const state = getState() as RootState;

  // 1. 加载 Agent 配置
  const agentConfig = await dispatch(read({ dbKey: agentKey })).unwrap();

  // 2. 加载 Agent 上下文（知识库 / references）
  const agentContexts = await fetchAgentContexts(
    agentConfig.references,
    dispatch
  );

  // 3. 构造首轮 body（generateRequestBody 会注入 system prompt）
  const initialMessages: Message[] = [{ role: "user", content }];
  const body = generateRequestBody({
    agentConfig,
    messages: initialMessages,
    userInput: typeof content === "string" ? content : JSON.stringify(content),
    contexts: agentContexts,
  });
  body.stream = false; // 多轮模式不用流式

  // body.messages 包含了 system 消息 + 用户消息，后续累积 tool 结果入此数组
  const messages: Message[] = body.messages as Message[];

  const api = getApiEndpoint(agentConfig);
  const currentServer = selectCurrentServer(state);
  const token = selectCurrentToken(state);

  let finalContent = "";
  let toolCallCount = 0;
  const toolFailureGuard: ToolFailureGuardState = {
    signature: null,
    count: 0,
  };

  // 4. 多轮循环
  loop:
  for (;;) {
    // 更新 messages（含累积的 tool 结果）
    body.messages = messages;

    const response = await performFetchRequest({
      agentConfig,
      api,
      bodyData: body as any,
      currentServer,
      token,
    });

    const data = await response.json();
    const choice = data.choices?.[0];

    if (billingDialogKey && data?.usage) {
      await updateTokensAction(
        {
          dialogId: extractCustomId(billingDialogKey),
          dialogKey: billingDialogKey,
          usage: data.usage,
          agentConfig,
        },
        thunkApi
      );
    }

    if (!choice) {
      console.warn("[runAgentClientLoop] 响应中找不到 choices[0]，停止");
      break;
    }

    const assistantMsg = choice.message;
    const finishReason: string = choice.finish_reason ?? "";

    // 追加 assistant 消息
    messages.push(assistantMsg);

    // 记录文本内容
    if (typeof assistantMsg.content === "string" && assistantMsg.content) {
      finalContent = assistantMsg.content;
    }

    // 无工具调用 or 模型明确 stop → 结束
    if (!assistantMsg.tool_calls?.length || finishReason === "stop") {
      break;
    }

    // 5. 执行工具调用
    for (const tc of assistantMsg.tool_calls) {
      toolCallCount++;
      const toolResultContent = await executeToolCall(tc, thunkApi, {
        parentMessageId,
        agentKey,
      });
      const stopReason = recordConsecutiveToolFailure(
        toolFailureGuard,
        tc,
        toolResultContent
      );
      if (stopReason) {
        finalContent = stopReason;
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResultContent,
        } as any);
        break loop;
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResultContent,
      } as any);
    }
  }

  return { content: finalContent, toolCallCount };
}
