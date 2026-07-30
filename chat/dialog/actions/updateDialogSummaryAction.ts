// 文件路径: packages/chat/dialog/actions/updateDialogSummaryAction.ts

import type { RootState } from "../../../app/store";
import { runLlm } from "../../../ai/agent/agentSlice";
import {
    buildBuiltinSummaryContent,
    BUILTIN_SUMMARY_LLM_CONFIG,
} from "./builtinDialogLlm";
import { patch, selectById } from "../../../database/dbSlice";
import { serializeMessageContent } from "../../messages/messageContent";
import { DialogConfig, Agent } from "../../../app/types";
import { getModelContextWindow, DEFAULT_CONTEXT_WINDOW } from "../../../ai/llm/getModelContextWindow";
import { extractCustomId } from "../../../core/prefix";
import type { Message } from "../../messages/types";
import { planCompression } from "../../../ai/context/planCompression";
import { extractReferenceKeysFromMessage } from "./extractReferenceKeys";

// --- 辅助函数 ---

const getMessagesForDialogFromState = (
    state: RootState,
    dialogId: string
): Message[] => {
    const msgsState = state.message.dialogStateById[dialogId]?.msgs;
    if (!msgsState || !msgsState.ids) return [];

    return (msgsState.ids as string[]).flatMap((id) => {
        const msg = msgsState.entities[id];
        return msg ? [msg as Message] : [];
    });
};

const formatMessagesForSummary = (msgs: Message[]): string =>
    msgs
        .map(m => {
            const content = serializeMessageContent(m.content) || "[非文本内容]";
            return `${m.role}: ${content}`;
        })
        .join("\n");


const summarizingDialogs = new Set<string>();

export const updateDialogSummaryAction = async (
    args: {
        dialogKey: string;
        preFetchedMessages?: Message[];
        force?: boolean;
        reason?: "task_completed" | "context_budget" | "manual";
    },
    thunkApi: any
) => {
    const { dialogKey, preFetchedMessages, force = false } = args;

    // 0. 并发锁：避免同一个 Dialog 同时进行多个摘要任务
    if (summarizingDialogs.has(dialogKey)) return;
    summarizingDialogs.add(dialogKey);

    const { dispatch, getState } = thunkApi;

    try {
        const state = getState() as RootState;
        const dialogId = extractCustomId(dialogKey);

        const dialogConfig = selectById(state, dialogKey) as DialogConfig;
        if (!dialogConfig) return;

        let contextWindow = DEFAULT_CONTEXT_WINDOW;
        if (dialogConfig.cybots && dialogConfig.cybots.length > 0) {
            const agentId = dialogConfig.cybots[0];
            const agent = selectById(state, agentId) as Agent;
            if (agent?.model) {
                contextWindow = getModelContextWindow(agent.model);
            }
        }

        // 2. 获取消息
        const allMsgs =
            preFetchedMessages || getMessagesForDialogFromState(state, dialogId);

        // 3. 纯函数决策：是否压缩 / 压缩多少 / 压缩哪些
        const plan = planCompression({
            allMsgs,
            summarizedBeforeId: dialogConfig.summarizedBeforeId,
            summary: dialogConfig.summary || "",
            contextWindow,
            force,
            reason: args.reason,
        });

        if (!plan.shouldCompress) return;

        const { msgsToCompress, newSummarizedBeforeId } = plan;

        // 4. 提取引用 Keys 并保存
        // 这一步非常重要：因为这些消息即将从 context 中消失，必须把 key 留下来。
        // 统一用 extractReferenceKeysFromMessage 覆盖 content / tool_calls / toolPayload
        // 三个来源，避免 tool 调用参数里引用的 page/dialog/table key 在压缩后永久丢失。
        const extractedKeys = new Set(dialogConfig.referenceKeys || []);
        for (const msg of msgsToCompress) {
            for (const key of extractReferenceKeysFromMessage(msg)) {
                extractedKeys.add(key);
            }
        }

        // 5. 生成新 Summary
        const previousSummary = dialogConfig.summary || "";
        const messagesText = formatMessagesForSummary(msgsToCompress);
        const promptContent = buildBuiltinSummaryContent(
            previousSummary,
            messagesText
        );

        try {
            // 调用内置 Summary LLM
            const newSummary = await dispatch(
                runLlm({
                    llmConfig: BUILTIN_SUMMARY_LLM_CONFIG,
                    content: promptContent,
                    billingDialogKey: dialogKey,
                })
            ).unwrap();

            if (newSummary && typeof newSummary === "string" && newSummary.trim()) {
                const currentCount = dialogConfig.compressionCount || 0;

                await dispatch(
                    patch({
                        dbKey: dialogKey,
                        changes: {
                            summary: newSummary.trim(),
                            summarizedBeforeId: newSummarizedBeforeId,
                            referenceKeys: Array.from(extractedKeys),
                            compressionCount: currentCount + 1,
                            summaryPending: false, // Explicitly clear pending flag
                        },
                    })
                ).unwrap();

                console.log(`[ContextCompression] Compressed ${plan.compressCount} messages. New summary len: ${newSummary.length}`);
            }
        } catch (err) {
            console.error("[ContextCompression] Failed:", err);
        }
    } finally {
        summarizingDialogs.delete(dialogKey);
    }
};