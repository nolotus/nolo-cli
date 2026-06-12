// 文件路径: packages/chat/dialog/actions/updateDialogSummaryAction.ts

import type { RootState } from "../../../app/store";
import { runLlm } from "../../../ai/agent/agentSlice";
import {
    buildBuiltinSummaryContent,
    BUILTIN_SUMMARY_LLM_CONFIG,
} from "./builtinDialogLlm";
import { patch, selectById } from "../../../database/dbSlice";
// import { selectAllMsgs, selectMsgsByDialogId } from "../../messages/messageSlice"; // CIRCULAR
import { serializeMessageContent } from "../../messages/messageContent";
import { DialogConfig, Agent } from "../../../app/types";
import { selectContextRetention } from "../../../app/settings/settingSlice";
import { getModelContextWindow } from "../../../ai/llm/getModelContextWindow";
import { estimateTokenCount } from "../../../ai/context/tokenUtils";
import { extractCustomId } from "../../../core/prefix";
import type { Message } from "../../messages/types";
import {
    ConversationLoad,
    planContextUsage,
} from "../../../ai/context/retention";

// --- 常量 ---
const MIN_COMPRESS_COUNT = 5; // 至少压缩5条以上才有意义
const MIN_PROACTIVE_MESSAGE_COUNT = 6;
const MIN_PROACTIVE_TOKENS = 1800;
const PROACTIVE_SUMMARY_MAX_INPUT_TOKENS = 12000;
const ACTIVE_SUMMARY_TAIL_KEEP_COUNT = 2;


// --- 辅助函数 ---

const getMessageTokenCount = (msg: any): number => {
    if (msg.usage?.completion_tokens) {
        return msg.usage.completion_tokens;
    }
    const content = serializeMessageContent(msg.content) || "";
    return estimateTokenCount(content);
};

const getMessagesForDialogFromState = (
    state: RootState,
    dialogId: string
): Message[] => {
    const msgsState = state.message.dialogStateById[dialogId]?.msgs;
    if (!msgsState || !msgsState.ids) return [];

    return (msgsState.ids as string[])
        .map(id => msgsState.entities[id])
        .filter(Boolean) as Message[];
};

const formatMessagesForSummary = (msgs: Message[]): string =>
    msgs
        .map(m => {
            const content = serializeMessageContent(m.content) || "[非文本内容]";
            return `${m.role}: ${content}`;
        })
        .join("\n");

const findMessageIndexById = (msgs: Message[], id?: string): number =>
    id ? msgs.findIndex(m => m.id === id) : -1;

const hasOpenEndedToolCall = (msg: Message | undefined): boolean =>
    !!msg && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0;

const truncateMessagesForSummary = (msgs: Message[]): Message[] => {
    let total = 0;
    let start = msgs.length;

    for (let i = msgs.length - 1; i >= 0; i--) {
        const t = getMessageTokenCount(msgs[i]);
        if (total + t > PROACTIVE_SUMMARY_MAX_INPUT_TOKENS) break;
        total += t;
        start = i;
    }

    return msgs.slice(start);
};

const buildPreviousSummaryWithProactive = (
    dialogConfig: DialogConfig,
    shouldConsumeProactive: boolean
): string => {
    const base = dialogConfig.summary || "";
    const proactive = shouldConsumeProactive ? dialogConfig.proactiveSummary || "" : "";

    if (!base && !proactive) return "";
    if (!proactive) return base;
    if (!base) return `【主动工作摘要】\n${proactive}`;

    return `${base}\n\n【主动工作摘要】\n${proactive}`;
};

const isActiveSummaryWorthDoing = (
    pendingTokens: number,
    contextWindow: number
): boolean => {
    const minTokens = Math.min(
        40_000,
        Math.max(10_000, Math.floor(contextWindow * 0.05))
    );
    return pendingTokens >= minTokens;
};

// --- Action ---
const classifyConversationLoad = (msgs: Message[]): ConversationLoad => {
    const N = 20;
    if (!Array.isArray(msgs) || msgs.length === 0) return "light";

    const tail = msgs.slice(-N);
    const tokenSamples = tail.map(getMessageTokenCount);
    if (tokenSamples.length === 0) return "light";

    const sum = tokenSamples.reduce((acc, v) => acc + v, 0);
    const avg = sum / tokenSamples.length;
    const sorted = [...tokenSamples].sort((a, b) => a - b);
    const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];

    if (p95 < 200 && avg < 120) {
        return "light";
    }

    if (p95 > 2000 || avg > 1200) {
        return "heavy";
    }

    return "medium";
};


const summarizingDialogs = new Set<string>();

export const updateDialogSummaryAction = async (
    args: {
        dialogKey: string;
        preFetchedMessages?: Message[];
        force?: boolean;
        reason?: "task_completed" | "context_budget";
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

        // 1. 获取配置
        const retention = selectContextRetention(state);

        let contextWindow = 128000;
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




        // 3. 找到最后一次压缩的位置
        const lastSummarizedId = dialogConfig.summarizedBeforeId;
        let startIndex = 0;
        if (lastSummarizedId) {
            const found = allMsgs.findIndex(m => m.id === lastSummarizedId);
            if (found !== -1) {
                startIndex = found + 1;
            }
        }

        // 待处理的消息（尚未被压缩进 summary）
        const pendingMsgs = allMsgs.slice(startIndex);
        if (pendingMsgs.length === 0) return;

        // 4. 计算当前总开销 = 已有 Summary + 待处理消息
        const summaryTokens = estimateTokenCount(dialogConfig.summary || "");
        const pendingTokens = pendingMsgs.reduce((sum, msg) => sum + getMessageTokenCount(msg), 0);
        const totalUsed = summaryTokens + pendingTokens;

        // 5. 基于模型窗口 / slider / 近期负载，规划历史预算
        const adjustedSummaryTokens = Math.max(summaryTokens, 1000);
        const recentLoad = classifyConversationLoad(pendingMsgs);

        const { historyBudget, rawMessageBudget } = planContextUsage({
            contextWindow,
            retentionSlider: retention,
            summaryTokens: adjustedSummaryTokens,
            recentLoad,
        });

        const shouldRunActiveSummary =
            force &&
            !hasOpenEndedToolCall(pendingMsgs[pendingMsgs.length - 1]) &&
            isActiveSummaryWorthDoing(pendingTokens, contextWindow);

        // 历史 + 待处理总开销未达到预算，且没有明确的主动归档信号，不触发压缩
        if (totalUsed < historyBudget && !shouldRunActiveSummary) {
            return;
        }

        // 6. 需要压缩：决定把哪些消息压进去
        // 目标：压缩后，summary + 保留的原始消息 ≈ historyBudget，
        //       且尽量保留最近的若干条消息。

        let tokensToKeep = 0;
        let keepCount = 0;

        // 从后往前数，保留最近的消息直到填满 rawMessageBudget
        for (let i = pendingMsgs.length - 1; i >= 0; i--) {
            const t = getMessageTokenCount(pendingMsgs[i]);
            if (tokensToKeep + t > rawMessageBudget) break;
            tokensToKeep += t;
            keepCount++;
        }

        // 主动归档时保留最后两条原文，避免刚给用户的结论立刻被折叠进 summary。
        let compressCount =
            shouldRunActiveSummary && totalUsed < historyBudget
                ? Math.max(0, pendingMsgs.length - ACTIVE_SUMMARY_TAIL_KEEP_COUNT)
                : pendingMsgs.length - keepCount;

        // Guard: Prevent breaking tool chains or compressing open-ended tool calls
        // OpenAI requires: Assistant(tool_calls) -> Tool(output) must be contiguous.

        // 1. Ensure we do not cut immediately before a 'tool' message.
        // If pendingMsgs[compressCount] (the first kept message) is 'tool', 
        // it means we are summarizing its parent 'assistant'. This is illegal.
        while (compressCount > 0 && compressCount < pendingMsgs.length && pendingMsgs[compressCount].role === 'tool') {
            compressCount--;
        }

        // 2. Ensure the last compressed message is not an assistant with tool_calls that needs a future tool output
        // (This is implicitly covered by #1 if tool output exists, but if tool output hasn't arrived yet, 
        // we must check the last message itself).
        // Actually, if tool output hasn't arrived, 'updateDialogSummaryAction' is usually called after 'messageStreamEnd'.
        // If the last message is Assistant(tool_calls), the NEXT message (not yet in list) will be Tool.
        // So we should NOT compress the last message if it has tool_calls.
        if (compressCount > 0) {
            const lastCompressed = pendingMsgs[compressCount - 1];
            const hasToolCalls = Array.isArray((lastCompressed as any).tool_calls) && (lastCompressed as any).tool_calls.length > 0;
            if (hasToolCalls) {
                // If we are chopping off the end of the conversation, and it ends with a tool call,
                // we must preserve it until tool output arrives.
                // Actually, just to be safe, never compress an active tool call.
                compressCount--;
            }
        }


        // 2. 可压缩的消息太少，不值得压缩
        if (compressCount < MIN_COMPRESS_COUNT) {
            return;
        }

        const msgsToCompress = pendingMsgs.slice(0, compressCount);


        // 最后一条被压缩的消息
        const newSummarizedBeforeId = msgsToCompress[msgsToCompress.length - 1].id;

        // 7. 提取引用 Keys (pageKey/dialogKey) 并保存
        // 这一步非常重要：因为这些消息即将从 context 中消失，必须把 key 留下来
        // 我们复用 addReferenceKeysAction 的逻辑，或者通过 content 提取
        // 这里直接提取然后 patch dialog
        const extractedKeys = new Set(dialogConfig.referenceKeys || []);
        msgsToCompress.forEach(msg => {
            // 简单遍历 content
            if (Array.isArray(msg.content)) {
                msg.content.forEach((p: any) => {
                    if (p?.pageKey) extractedKeys.add(p.pageKey);
                    if (p?.dialogKey) extractedKeys.add(p.dialogKey);
                });
            } else if (msg.content && typeof msg.content === 'object') {
                const c: any = msg.content;
                if (c.pageKey) extractedKeys.add(c.pageKey);
                if (c.dialogKey) extractedKeys.add(c.dialogKey);
            }
        });

        // 8. 生成新 Summary (结构化记忆升级版)
        // 目标：将线性摘要升级为 "事实 (Facts) + 剧情 (Narrative)" 双轨记忆。
        // 这能显著提升 Agent 的 "智商"，防止关键配置在长对话中被遗忘。

        const proactiveBeforeIndex = findMessageIndexById(
            allMsgs,
            dialogConfig.proactiveSummaryBeforeId
        );
        const shouldConsumeProactive =
            !!dialogConfig.proactiveSummary &&
            proactiveBeforeIndex !== -1 &&
            proactiveBeforeIndex < startIndex + compressCount;

        const previousSummary = buildPreviousSummaryWithProactive(
            dialogConfig,
            shouldConsumeProactive
        );
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
                            ...(shouldConsumeProactive
                                ? {
                                    proactiveSummary: "",
                                    proactiveSummaryBeforeId: undefined,
                                }
                                : {}),
                        },
                    })
                ).unwrap();

                console.log(`[ContextCompression] Compressed ${compressCount} messages. New summary len: ${newSummary.length}`);
            }
        } catch (err) {
            console.error("[ContextCompression] Failed:", err);
        }
    } finally {
        summarizingDialogs.delete(dialogKey);
    }
};

export const updateDialogProactiveSummaryAction = async (
    args: { dialogKey: string; preFetchedMessages?: Message[] },
    thunkApi: any
) => {
    const { dialogKey, preFetchedMessages } = args;
    if (summarizingDialogs.has(dialogKey)) return;
    if (summarizingDialogs.has(`proactive:${dialogKey}`)) return;
    summarizingDialogs.add(`proactive:${dialogKey}`);

    const { dispatch, getState } = thunkApi;

    try {
        const state = getState() as RootState;
        const dialogId = extractCustomId(dialogKey);
        const dialogConfig = selectById(state, dialogKey) as DialogConfig;
        if (!dialogConfig) return;

        const allMsgs = preFetchedMessages || getMessagesForDialogFromState(state, dialogId);
        if (!allMsgs.length) return;

        const hardSummaryIndex = findMessageIndexById(allMsgs, dialogConfig.summarizedBeforeId);
        const proactiveIndex = findMessageIndexById(allMsgs, dialogConfig.proactiveSummaryBeforeId);
        const startIndex = Math.max(hardSummaryIndex, proactiveIndex) + 1;
        const pendingMsgs = allMsgs.slice(startIndex);
        if (pendingMsgs.length < MIN_PROACTIVE_MESSAGE_COUNT) return;

        if (hasOpenEndedToolCall(pendingMsgs[pendingMsgs.length - 1])) return;

        const pendingTokens = pendingMsgs.reduce((sum, msg) => sum + getMessageTokenCount(msg), 0);
        const hasToolOutput = pendingMsgs.some(msg => msg.role === "tool");
        if (!hasToolOutput && pendingTokens < MIN_PROACTIVE_TOKENS) return;

        const msgsToSummarize = truncateMessagesForSummary(pendingMsgs);
        if (msgsToSummarize.length < MIN_PROACTIVE_MESSAGE_COUNT && !hasToolOutput) return;

        const newProactiveBeforeId = pendingMsgs[pendingMsgs.length - 1].id;
        const previousSummary = dialogConfig.proactiveSummary || "";
        const messagesText = formatMessagesForSummary(msgsToSummarize);
        const promptContent = buildBuiltinSummaryContent(previousSummary, messagesText);

        try {
            const newSummary = await dispatch(
                runLlm({
                    llmConfig: BUILTIN_SUMMARY_LLM_CONFIG,
                    content: promptContent,
                    billingDialogKey: dialogKey,
                })
            ).unwrap();

            if (newSummary && typeof newSummary === "string" && newSummary.trim()) {
                await dispatch(
                    patch({
                        dbKey: dialogKey,
                        changes: {
                            proactiveSummary: newSummary.trim(),
                            proactiveSummaryBeforeId: newProactiveBeforeId,
                        },
                    })
                ).unwrap();

                console.log(`[ContextCompression] Proactive summary updated. len: ${newSummary.length}`);
            }
        } catch (err) {
            console.error("[ContextCompression] Proactive summary failed:", err);
        }
    } finally {
        summarizingDialogs.delete(`proactive:${dialogKey}`);
    }
};
