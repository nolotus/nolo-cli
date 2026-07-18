// 文件路径: chat/messages/toolThunks.ts

import { createAsyncThunk } from "@reduxjs/toolkit";
import { toErrorMessage } from "../../core/errorMessage";
import { isRecord } from "../../core/isRecord";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { findToolExecutor, toolDefinitionsByName } from "../../ai/tools";
import { getToolResultErrorData } from "../../ai/tools/toolResultError";
import {
  toolRunStarted,
  toolRunSucceeded,
  toolRunFailed,
  createToolRunId,
  toolRunSetPending,
} from "../../ai/tools/toolRunSlice";
import { streamAgentChatTurn } from "../../ai/agent/agentSlice";

import type { Message, ToolPayload, ToolErrorPayload } from "./types";
import { addToolMessage, updateToolMessage } from "./messageSlice";
import { persistToolMessage } from "./persistToolMessage";
import { dialogMessageKey } from "../../database/keys";

const TOOL_ARGS_SENTINELS = [
  "<|tool_calls_section_end|>",
  "<|tool_calls_end|>",
  "<|endofjson|>",
];

function cleanToolArguments(argStr: string): string {
  if (!argStr) return argStr;

  let cleaned = argStr;
  for (const s of TOOL_ARGS_SENTINELS) {
    const idx = cleaned.indexOf(s);
    if (idx >= 0) {
      cleaned = cleaned.slice(0, idx);
    }
  }

  return cleaned.trim();
}

const defaultSummary = (toolName: string, status: ToolPayload["status"]) => {
  if (status === "pending") return `⏸️ ${toolName} 等待确认/授权`;
  if (status === "running") return `⏳ ${toolName} 执行中…`;
  if (status === "failed") return `❌ ${toolName} 执行失败`;
  return `✅ ${toolName} 执行完成`;
};

interface ProcessToolDataPayload {
  toolCall: any;
  parentMessageId: string;
  toolRunId: string;
}

export interface HandleToolCallsPayload {
  accumulatedCalls: any[];
  currentContentBuffer: any[];
  agentConfig: any;
  messageId: string;
  dialogId: string;
  dialogKey?: string;
}

const processToolData = createAsyncThunk(
  "message/processToolData",
  async (args: ProcessToolDataPayload, thunkApi: any) => {
    const { toolCall, parentMessageId, toolRunId } = args;
    const { dispatch, rejectWithValue } = thunkApi;

    const func = toolCall.function;
    if (!func || !func.name) {
      throw new Error(
        "Invalid tool call data: missing function or function.name"
      );
    }

    const toolCallId =
      toolCall.id ||
      `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const rawToolName = func.name;
    let toolArgs = func.arguments;

    const found = findToolExecutor(rawToolName);
    const canonicalName = found.canonicalName;

    const def = toolDefinitionsByName[canonicalName];
    const behavior = def?.behavior;
    const interaction = def?.interaction ?? "auto";

    if (typeof toolArgs === "string") {
      const cleaned = cleanToolArguments(toolArgs);
      try {
        toolArgs = JSON.parse(cleaned);
      } catch (e) {
        console.error(
          "[ToolThunks/processToolData] toolArgs JSON.parse failed:",
          toolArgs
        );
        throw new Error(`Failed to parse tool arguments JSON: ${e}`);
      }
    }

    const activity =
      isRecord(toolArgs) && isRecord(toolArgs._activity)
        ? toolArgs._activity
        : undefined;
    const executionToolArgs =
      isRecord(toolArgs) &&
      Object.prototype.hasOwnProperty.call(toolArgs, "_activity")
        ? (({ _activity: _ignored, ...rest }) => rest)(toolArgs)
        : toolArgs;

    const inputSummary = JSON.stringify(executionToolArgs).slice(0, 400);

    dispatch(
      toolRunStarted({
        id: toolRunId,
        messageId: parentMessageId,
        toolName: canonicalName,
        behavior,
        inputSummary,
        interaction,
        input: executionToolArgs,
      })
    );

    // ========= 分支一：confirm / authorize 工具，走预览（暂停） =========
    if (interaction === "confirm" || interaction === "authorize") {
      try {
        dispatch(toolRunSetPending({ id: toolRunId }));

        const previewExecutor = def?.previewExecutor;
        const previewResult = previewExecutor
          ? await previewExecutor(executionToolArgs, thunkApi, { parentMessageId })
          : {
            rawData: {
              previewOnly: true,
              toolName: canonicalName,
              interaction,
            },
          };

        const rawData = previewResult?.rawData ?? previewResult;

        const summary =
          (typeof previewResult?.displayData === "string" &&
            previewResult.displayData.trim()) ||
          (interaction === "authorize"
            ? `🔐 ${canonicalName} 需要授权后执行`
            : `⚠️ ${canonicalName} 需要确认后执行`);

        const toolPayload: ToolPayload = {
          toolName: canonicalName,
          status: "pending",
          input: executionToolArgs,
          rawToolCall: toolCall,
          toolRunId,
          summary,
          ...(activity ? { activity } : {}),
        };

        return {
          toolCallId,
          rawResult: rawData,
          summary,
          toolName: canonicalName,
          toolRunId,
          toolPayload,
          hasPendingInteraction: true, // ✅ 暂停点
        };
      } catch (e: any) {
        const errorMessage = toErrorMessage(e);
        const structured = getToolResultErrorData(e);
        const rawErrorResult =
          structured?.rawData !== undefined ? structured.rawData : { error: errorMessage };
        const summary =
          asOptionalTrimmedString(structured?.displayData) ||
          `❌ ${canonicalName} 预览失败: ${errorMessage}`;

        dispatch(
          toolRunFailed({
            id: toolRunId,
            error: errorMessage,
            outputSummary: summary,
          })
        );

        const errorPayload: ToolErrorPayload = {
          type: e?.name || "Error",
          message: errorMessage,
          code: structured?.code ?? e?.code,
          retryable: structured?.retryable ?? e?.retryable ?? true,
        };

        const toolPayload: ToolPayload = {
          toolName: canonicalName,
          status: "failed",
          input: executionToolArgs,
          rawToolCall: toolCall,
          error: errorPayload,
          toolRunId,
          summary,
          ...(activity ? { activity } : {}),
        };

        return rejectWithValue({
          toolCallId,
          rawResult: rawErrorResult,
          summary,
          toolName: canonicalName,
          toolRunId,
          toolPayload,
          hasPendingInteraction: true,
        });
      }
    }

    // ========= 分支二：auto 工具（包括 ui_ask_choice / readFile / createWorkflow 等） =========
    try {
      const toolResult = await found.executor(executionToolArgs, thunkApi, {
        parentMessageId,
        toolRunId,
      });

      const rawData = toolResult?.rawData ?? toolResult;
      const llmContext = asOptionalTrimmedString(toolResult?.llmContext);

      const summary =
        asOptionalTrimmedString(toolResult?.displayData) ||
        defaultSummary(canonicalName, "succeeded");

      dispatch(
        toolRunSucceeded({
          id: toolRunId,
          outputSummary: summary,
        })
      );

      const toolPayload: ToolPayload = {
        toolName: canonicalName,
        status: "succeeded",
        input: executionToolArgs,
        rawToolCall: toolCall,
        toolRunId,
        summary,
        ...(llmContext ? { llmContext } : {}),
        ...(activity ? { activity } : {}),
      };

      // ✅ 关键：ui_ask_choice(blocking=true) 也视作“暂停点”
      const isUiAskChoice = canonicalName === "ui_ask_choice";
      const blocking =
        typeof executionToolArgs?.blocking === "boolean"
          ? executionToolArgs.blocking
          : true; // schema 默认 true

      const hasPendingInteraction =
        isUiAskChoice && blocking === true;

      return {
        toolCallId,
        rawResult: rawData,
        summary,
        toolName: canonicalName,
        toolRunId,
        toolPayload,
        hasPendingInteraction,
      };
    } catch (e: any) {
      const errorMessage = toErrorMessage(e);
      const structured = getToolResultErrorData(e);
      const requiresConfirmation =
        structured?.code === "self_evolution_requires_confirmation" ||
        structured?.code === "agent_update_requires_confirmation";

      if (requiresConfirmation) {
        const confirmedInput = {
          ...(executionToolArgs ?? {}),
          __confirmedSelfEvolution: true,
        };
        const summary =
          (typeof structured?.displayData === "string" &&
            structured.displayData.trim()) ||
          `⚠️ ${canonicalName} 需要确认后执行`;

        dispatch(
          toolRunStarted({
            id: toolRunId,
            messageId: parentMessageId,
            toolName: canonicalName,
            behavior,
            inputSummary: JSON.stringify(confirmedInput).slice(0, 400),
            interaction: "confirm",
            input: confirmedInput,
          })
        );
        dispatch(toolRunSetPending({ id: toolRunId }));

        const toolPayload: ToolPayload = {
          toolName: canonicalName,
          status: "pending",
          input: confirmedInput,
          rawToolCall: toolCall,
          toolRunId,
          summary,
          ...(activity ? { activity } : {}),
        };

        return {
          toolCallId,
          rawResult:
            structured?.rawData !== undefined
              ? structured.rawData
              : { error: "self_evolution_requires_confirmation" },
          summary,
          toolName: canonicalName,
          toolRunId,
          toolPayload,
          hasPendingInteraction: true,
        };
      }

      const rawErrorResult =
        structured?.rawData !== undefined ? structured.rawData : { error: errorMessage };
      const summary =
        asOptionalTrimmedString(structured?.displayData) ||
        `❌ ${canonicalName} 执行失败: ${errorMessage}`;

      dispatch(
        toolRunFailed({
          id: toolRunId,
          error: errorMessage,
          outputSummary: summary,
        })
      );

      const errorPayload: ToolErrorPayload = {
        type: e?.name || "Error",
        message: errorMessage,
        code: structured?.code ?? e?.code,
        retryable: structured?.retryable ?? e?.retryable ?? true,
      };

      const toolPayload: ToolPayload = {
        toolName: canonicalName,
        status: "failed",
        input: executionToolArgs,
        rawToolCall: toolCall,
        error: errorPayload,
        toolRunId,
        summary,
        ...(activity ? { activity } : {}),
      };

      return rejectWithValue({
        toolCallId,
        rawResult: rawErrorResult,
        summary,
        toolName: canonicalName,
        toolRunId,
        toolPayload,
        hasPendingInteraction: false,
      });
    }
  }
);

export const handleToolCalls = createAsyncThunk(
  "message/handleToolCalls",
  async (args: HandleToolCallsPayload, thunkApi: any) => {
    const {
      accumulatedCalls,
      currentContentBuffer,
      agentConfig,
      messageId,
      dialogId,
      dialogKey,
    } = args;

    const { dispatch } = thunkApi;

    const updatedContentBuffer = [...currentContentBuffer];
    let hasHandedOff = false;
    let hasPendingInteraction = false;

    for (let toolIndex = 0; toolIndex < accumulatedCalls.length; toolIndex++) {
      const toolCall = accumulatedCalls[toolIndex];
      if (!toolCall.function?.name) continue;

      const toolCallId =
        toolCall.id ||
        `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const toolRunId = createToolRunId();
      // 从 parent 消息 ID 派生 tool 消息 ID，保证 tool 排在 parent 之后、下一个 assistant 之前
      const canonicalToolName = findToolExecutor(toolCall.function.name).canonicalName;
      const runningToolMessageId = `${messageId}-t${String(toolIndex).padStart(3, "0")}`;
      const runningToolDbKey = dialogMessageKey(dialogId, runningToolMessageId);
      const runningToolMessage: Message = {
        id: runningToolMessageId,
        dbKey: runningToolDbKey,
        role: "tool",
        content: JSON.stringify({ pending: true }),
        toolCallId,
        thinkContent: "",
        cybotKey: agentConfig.dbKey,
        isStreaming: true,
        toolName: canonicalToolName,
        parentMessageId: messageId,
        toolRunId,
        toolPayload: {
          toolName: canonicalToolName,
          status: "running",
          input: {},
          rawToolCall: toolCall,
          toolRunId,
          summary: defaultSummary(canonicalToolName, "running"),
        },
      };

      dispatch(addToolMessage(runningToolMessage));
      // Same durable write path as desktop local runtime (persistToolMessage).
      await persistToolMessage(dispatch, runningToolMessage, {
        isStreaming: true,
        soft: true,
      });

      try {
        const result = await dispatch(
          processToolData({
            toolCall: { ...toolCall, id: toolCallId },
            parentMessageId: messageId,
            toolRunId,
          })
        ).unwrap();

        const toolName = result.toolName;
        let rawResult = result.rawResult;
        let toolPayload = result.toolPayload;

        if (toolName) {
          const completedToolMessage = {
            ...runningToolMessage,
            content: JSON.stringify(rawResult),
            toolCallId: result.toolCallId,
            isStreaming: false,
            toolName,
            toolRunId: result.toolRunId,
            toolPayload,
          };
          dispatch(
            updateToolMessage({
              id: runningToolMessageId,
              changes: {
                content: completedToolMessage.content,
                toolCallId: completedToolMessage.toolCallId,
                isStreaming: false,
                toolName,
                toolRunId: result.toolRunId,
                toolPayload,
              },
            })
          );

          await persistToolMessage(dispatch, completedToolMessage, {
            isStreaming: false,
            soft: true,
          });

          if (result.hasPendingInteraction) {
            hasPendingInteraction = true;
          }

          // handoff 型工具：runStreamingAgent
          if (toolName === "runStreamingAgent") {
            const raw = (result.rawResult as any) ?? {};
            const agentKey = raw.agentKey;
            const userInput = raw.userInput;
            const serverBase = asOptionalTrimmedString(raw.serverBase);

            if (agentKey && userInput) {
              hasHandedOff = true;
              void dispatch(
                streamAgentChatTurn({
                  agentKey,
                  userInput,
                  ...(dialogKey ? { dialogKey } : {}),
                  ...(serverBase ? { serverBase } : {}),
                })
              );
            }
          }

        }
      } catch (rejectedValue: any) {
        console.error(
          "[ToolThunks/handleToolCalls] processToolData rejected:",
          rejectedValue
        );

        if (rejectedValue.toolName) {
          const errorResult = {
            error: true,
            message:
              rejectedValue.toolPayload?.error?.message || "未知错误",
          };
          const failedToolMessage = {
            ...runningToolMessage,
            content: JSON.stringify(errorResult),
            toolCallId: rejectedValue.toolCallId,
            isStreaming: false,
            toolName: rejectedValue.toolName,
            toolRunId: rejectedValue.toolRunId,
            toolPayload: rejectedValue.toolPayload,
          };
          dispatch(
            updateToolMessage({
              id: runningToolMessageId,
              changes: {
                content: failedToolMessage.content,
                toolCallId: failedToolMessage.toolCallId,
                isStreaming: false,
                toolName: rejectedValue.toolName,
                toolRunId: rejectedValue.toolRunId,
                toolPayload: rejectedValue.toolPayload,
              },
            })
          );

          await persistToolMessage(dispatch, failedToolMessage, {
            isStreaming: false,
            soft: true,
          });

          if (rejectedValue.hasPendingInteraction) {
            hasPendingInteraction = true;
          }
        }
      }
    }

    return {
      finalContentBuffer: updatedContentBuffer,
      hasHandedOff,
      hasPendingInteraction,
    };
  }
);
