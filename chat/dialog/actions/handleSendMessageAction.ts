// 文件路径: chat/dialog/actions/handleSendMessageAction.ts

import type { RootState } from "../../../app/store";
import type { AgentRuntimeOptions } from "../../../ai/agent/types";
import {
    messageStreamEnd,
    prepareAndPersistUserMessage,
} from "../../messages/messageSlice";
import { streamAgentChatTurn } from "../../../ai/agent/agentSlice";
import { readAndWait, selectById } from "../../../database/dbSlice";
import type { DialogConfig } from "../../../app/types";
import { createDialogMessageKeyAndId } from "../../../database/keys";
import { extractCustomId } from "../../../core/prefix";
import { resolveHandleSendMessageContext } from "./handleSendMessageResolver";

export interface HandleSendMessageArgs {
    userInput: string | any[];
    dialogKey?: string;
    runtimeOptions?: AgentRuntimeOptions;
    /** 可选：本轮显式指定要调用的 Agent ID（来自 @mention） */
    targetAgentKey?: string;
    quickChatPerfStartedAt?: number;
}

interface HandleSendMessageThunkApi {
    dispatch: any;
    getState: () => RootState;
    rejectWithValue: (value: unknown) => unknown;
}

const getDialogConfig = (
    state: RootState,
    dialogKey?: string
): DialogConfig | null => {
    const resolvedDialogKey = dialogKey ?? state.dialog?.currentDialogKey;
    if (!resolvedDialogKey) return null;

    const dialog = selectById(state, resolvedDialogKey) as DialogConfig | null;
    return dialog ?? null;
};

const ensureDialogConfig = async (
    dispatch: any,
    getState: () => RootState,
    dialogKey?: string
): Promise<DialogConfig | null> => {
    const state = getState();
    const resolvedDialogKey = dialogKey ?? state.dialog?.currentDialogKey;
    if (!resolvedDialogKey) return null;

    try {
        const existingDialog = getDialogConfig(state, resolvedDialogKey);
        if (
            existingDialog &&
            Array.isArray(existingDialog.cybots) &&
            existingDialog.cybots.length > 0
        ) {
            return existingDialog;
        }

        const persistedDialog = (await dispatch(readAndWait(resolvedDialogKey)).unwrap()) as DialogConfig;
        if (persistedDialog) return persistedDialog;

        return existingDialog;
    } catch {
        return getDialogConfig(getState(), resolvedDialogKey);
    }
};

const logQuickChatPerfStage = (
    startedAt: number | undefined,
    stage: string,
    details: Record<string, unknown> = {}
) => {
    if (!startedAt) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    console.info("[QuickChatPerf]", {
        stage,
        elapsedMs: now - startedAt,
        ...(typeof performance !== "undefined" ? { atMs: now } : {}),
        ...details,
    });
};

const finalizeQuickChatStreamStartupFailure = async (
    dispatch: any,
    dialogConfig: DialogConfig,
    agentKey: string,
) => {
    const dialogKey = dialogConfig.dbKey;
    const dialogId = dialogConfig.id ?? extractCustomId(dialogKey);
    const { key: msgKey, messageId } = createDialogMessageKeyAndId(dialogId);

    await dispatch(
        messageStreamEnd({
            finalContentBuffer: [
                {
                    type: "text",
                    text: "[错误: 未能启动模型回复，请重试。]",
                },
            ],
            totalUsage: null,
            msgKey,
            agentConfig: {
                dbKey: agentKey,
            },
            dialogId,
            dialogKey,
            messageId,
            reasoningBuffer: "",
        })
    ).unwrap?.();
};

/**
 * 发送用户消息（当前对话）：
 * - 支持 runtimeOptions：用于为当前轮次额外注入工具 / 编辑上下文
 * - 支持 targetAgentKey：本轮可显式指定要调用的 Agent（例如通过 @mention）
 * - 默认行为不变：老调用只传 userInput 仍然有效
 */
export const handleSendMessageAction = async (
    args: HandleSendMessageArgs,
    { dispatch, getState, rejectWithValue }: HandleSendMessageThunkApi
) => {
    try {
        logQuickChatPerfStage(args.quickChatPerfStartedAt, "handle-send-message-entered", {
            dialogKey: args.dialogKey ?? null,
        });
        const dialogConfig = await ensureDialogConfig(dispatch, getState, args.dialogKey);
        if (!dialogConfig) {
            throw new Error(
                "handleSendMessage: Dialog configuration is missing."
            );
        }
        logQuickChatPerfStage(args.quickChatPerfStartedAt, "handle-send-message-dialog-ready", {
            dialogKey: dialogConfig.dbKey,
            cybotCount: dialogConfig.cybots?.length ?? 0,
        });

        // 步骤 1: 准备并持久化用户的消息
        await dispatch(
            prepareAndPersistUserMessage({
                userInput: args.userInput,
                dialogConfig,
            })
        ).unwrap();
        logQuickChatPerfStage(args.quickChatPerfStartedAt, "handle-send-message-user-persisted", {
            dialogKey: dialogConfig.dbKey,
        });

        // 步骤 2: 计算本轮要实际调用的 agentKey
        const { agentKeyToUse, effectiveRuntimeOptions } =
            resolveHandleSendMessageContext({
                dialogConfig,
                targetAgentKey: args.targetAgentKey,
                runtimeOptions: args.runtimeOptions,
            });

        // 没有可用 Agent 时，只保存用户消息，不触发 Agent 回复
        if (!agentKeyToUse) {
            return;
        }

        // 步骤 3: 触发 Agent 的回合
        const streamResult = await dispatch(
            streamAgentChatTurn({
                agentKey: agentKeyToUse,
                userInput: args.userInput,
                dialogKey: dialogConfig.dbKey,
                parentMessageId: undefined,
                runtimeOptions: effectiveRuntimeOptions,
                quickChatPerfStartedAt: args.quickChatPerfStartedAt,
            })
        ).unwrap();
        if (args.quickChatPerfStartedAt && streamResult === undefined) {
            logQuickChatPerfStage(args.quickChatPerfStartedAt, "handle-send-message-stream-empty", {
                dialogKey: dialogConfig.dbKey,
                agentKey: agentKeyToUse,
            });
            await finalizeQuickChatStreamStartupFailure(
                dispatch,
                dialogConfig,
                agentKeyToUse,
            );
            return;
        }
        logQuickChatPerfStage(args.quickChatPerfStartedAt, "handle-send-message-stream-finished", {
            dialogKey: dialogConfig.dbKey,
            agentKey: agentKeyToUse,
        });

        return;
    } catch (error: any) {
        console.error("handleSendMessage failed:", error);
        const errorMessage = error instanceof Error
            ? error.message
            : typeof error === "string"
            ? error
            : error?.message || error?.error || String(error);
        return rejectWithValue(errorMessage);
    }
};
