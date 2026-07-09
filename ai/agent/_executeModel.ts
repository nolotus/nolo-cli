import { RootState } from "../../app/store";
import { Agent, Message } from "../../app/types";
import { selectCurrentDialogConfig } from "../../chat/dialog/dialogSlice";
import { read } from "../../database/dbSlice";
import { fetchAgentContexts } from "../agent/fetchAgentContexts";
import { filterAndCleanMessages } from "../../integrations/openai/filterAndCleanMessages";
import { selectAllMsgs } from "../../chat/messages/messageSlice";
import { generateRequestBody } from "../llm/generateRequestBody";
import { getApiEndpoint } from "../llm/providers";
import { selectCurrentServer } from "../../app/settings/settingSlice";
import { selectCurrentToken } from "../../auth/authSlice";
import { applyChatCompletionsStreamMode } from "../../integrations/openai/chatCompletionStreamMode";

import { sendOpenAICompletionsRequest } from "../chat/sendOpenAICompletionsRequest";
import { performFetchRequest } from "../chat/fetchUtils";
import { updateTokensAction } from "../../chat/dialog/actions/updateTokensAction";
import { extractCustomId } from "../../core/prefix";

export const _executeModel = async (
  options: {
    isStreaming: boolean;
    withAgentContext: boolean;
    withChatHistory: boolean;
    agentConfigOverrides?: Record<string, any>;
  },
  args: {
    llmConfig?: Partial<Agent> & Pick<Agent, "provider" | "model">;
    agentKey?: string;
    agentConfig?: Partial<Agent> & Pick<Agent, "provider" | "model">;
    content: any;
    parentMessageId?: string;
    billingDialogKey?: string;
  },
  thunkApi: any
) => {
  const { isStreaming, withAgentContext, withChatHistory, agentConfigOverrides } = options;
  const { getState, dispatch, rejectWithValue } = thunkApi;
  const { content } = args;
  const state = getState() as RootState;

  let agentConfig: Partial<Agent> & Pick<Agent, "provider" | "model">;
  if (args.llmConfig) {
    agentConfig = args.llmConfig;
  } else if (args.agentConfig) {
    agentConfig = args.agentConfig;
  } else {
    const agentKey = args.agentKey || selectCurrentDialogConfig(state)?.cybots?.[0];
    if (!agentKey) {
      const msg = "Model execution failed: No llmConfig, agentConfig, or agentKey provided.";
      console.error(msg);
      return rejectWithValue(msg);
    }
    try {
      agentConfig = await dispatch(read({ dbKey: agentKey })).unwrap();
    } catch (error: any) {
      console.error(`_executeModel failed to load agent [${agentKey}]`, error);
      return rejectWithValue(error.message);
    }
  }

  try {
    const resolvedConfig = agentConfigOverrides
      ? { ...agentConfig, ...agentConfigOverrides }
      : agentConfig;
    const resolvedAgentConfig = resolvedConfig as Agent;
    const agentContexts = withAgentContext
      ? await fetchAgentContexts(resolvedAgentConfig.references, dispatch)
      : {};

    let messages: Message[];
    if (withChatHistory) {
      messages = filterAndCleanMessages(selectAllMsgs(state)) as unknown as Message[];
      messages.push({ role: "user", content: args.content });
    } else {
      messages = [{ role: "user", content: args.content }];
    }

    const requestBody = generateRequestBody({
      agentConfig: resolvedAgentConfig,
      messages,
      userInput: content,
      contexts: agentContexts,
    });
    const bodyData = applyChatCompletionsStreamMode(requestBody, isStreaming) as any;
    const currentDialogKey = selectCurrentDialogConfig(state)?.dbKey ?? "";

    if (isStreaming) {
      await sendOpenAICompletionsRequest({
        bodyData,
        agentConfig: resolvedAgentConfig,
        thunkApi,
        dialogKey: currentDialogKey,
        parentMessageId: args.parentMessageId,
      });
    } else {
      const response = await performFetchRequest({
        agentConfig: resolvedAgentConfig,
        api: getApiEndpoint(resolvedAgentConfig),
        bodyData,
        currentServer: selectCurrentServer(state),
        token: selectCurrentToken(state) ?? "",
      });
      if (!response.ok) {
        let message = `Model request failed with HTTP ${response.status}`;
        try {
          const errorBody = await response.json();
          const upstreamMessage =
            typeof errorBody?.error?.message === "string"
              ? errorBody.error.message
              : typeof errorBody?.message === "string"
                ? errorBody.message
                : "";
          if (upstreamMessage.trim()) message = upstreamMessage.trim();
        } catch {
          // Keep the status-based message when the response body is not JSON.
        }
        throw new Error(message);
      }
      const result = await response.json();
      const content = result?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        const upstreamMessage =
          typeof result?.error?.message === "string" ? result.error.message : "";
        throw new Error(
          upstreamMessage.trim() ||
          "Model response missing choices[0].message.content"
        );
      }
      if (args.billingDialogKey && result?.usage) {
        await updateTokensAction(
          {
            dialogId: extractCustomId(args.billingDialogKey),
            dialogKey: args.billingDialogKey,
            usage: result.usage,
            agentConfig: resolvedAgentConfig,
          },
          thunkApi
        );
      }
      return content;
    }
  } catch (error: any) {
    console.error(`_executeModel failed`, error);
    return rejectWithValue(error.message);
  }
};
