// 文件路径: packages/chat/dialog/actions/updateDialogSummaryAction.ts

import type { RootState } from "../../../app/store";
import { runLlm } from "../../../ai/agent/agentSlice";
import { BUILTIN_SUMMARY_LLM_CONFIG } from "./builtinDialogLlm";
import { patch, selectById } from "../../../database/dbSlice";
import { DialogConfig, Agent } from "../../../app/types";
import { getModelContextWindow, DEFAULT_CONTEXT_WINDOW } from "../../../ai/llm/getModelContextWindow";
import { extractCustomId } from "../../../core/prefix";
import type { Message } from "../../messages/types";
import { planCompression } from "../../../ai/context/planCompression";
import { estimateTokenCount } from "../../../ai/context/tokenUtils";
import { extractReferenceKeysFromMessage } from "./extractReferenceKeys";
import {
    COMPACTION_SUMMARY_SYSTEM_PROMPT,
    formatMessagesForSummaryWithTruncation,
    formatFileOperationsFromMessages,
    buildCompactionUserContent,
    buildCompactionMetricsFromPlan,
    formatCompactionMetricsLog,
} from "../../../ai/context/compactionShared";

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

/**
 * Web 端没有 tool name alias 系统，直接用原始 tool name。
 * readFile/writeFile/editFile 是 bun-nolo 的标准工具名，无需 canonicalize。
 */
const identityCanonicalName = (name: string): string => name;


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
            // 防死亡螺旋：用 summary 长度作为上次压缩后的基线。
            lastCompactedTokenCount: dialogConfig.summary
                ? estimateTokenCount(dialogConfig.summary)
                : undefined,
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

        // 5. 生成新 Summary（统一用共享模块的三段式 prompt + 截断 + 文件操作清单）
        const previousSummary = dialogConfig.summary || "";
        const messagesText = formatMessagesForSummaryWithTruncation(msgsToCompress);
        const fileOpsText = formatFileOperationsFromMessages(
            msgsToCompress,
            identityCanonicalName,
        );
        const promptContent = buildCompactionUserContent({
            previousSummary,
            messagesText,
            fileOpsText,
        });

        try {
            // 调用内置 Summary LLM，用统一的 system prompt 覆盖原 BUILTIN_SUMMARY_LLM_CONFIG.prompt
            const newSummary = await dispatch(
                runLlm({
                    llmConfig: {
                        ...BUILTIN_SUMMARY_LLM_CONFIG,
                        prompt: COMPACTION_SUMMARY_SYSTEM_PROMPT,
                    },
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

                // P1-8 压缩埋点
                const metrics = buildCompactionMetricsFromPlan({
                    reason: args.reason || "context_budget",
                    previousSummary: dialogConfig.summary || "",
                    plan,
                    newSummary: newSummary.trim(),
                    // web 端 runLlm 只返回摘要字符串，不含 usage。
                    // summaryUsage 需要 runLlm 改造才能获取，当前留空。
                });
                console.log(formatCompactionMetricsLog(metrics));
            }
        } catch (err) {
            console.error("[ContextCompression] Failed:", err);
        }
    } finally {
        summarizingDialogs.delete(dialogKey);
    }
};