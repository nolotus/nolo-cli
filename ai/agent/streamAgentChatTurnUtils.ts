// 文件路径: packages/ai/agent/streamAgentChatTurnUtils.ts

import type { RootState } from "../../app/store";
import { read, selectById } from "../../database/dbSlice";
import { fetchReferenceContents } from "../context/buildReferenceContext";
import {
    selectPendingFiles,
    type PendingFile,
} from "../../chat/dialog/dialogSlice";
import { selectAllMsgs } from "../../chat/messages/messageSlice";
import { selectCurrentSpace, selectViewMode } from "../../create/space/spaceSlice";
import { createSpaceKey } from "../../create/space/spaceKeys";
import {
    selectAiRecentContentLimit,
    selectGlobalPrompt,
    selectKnowledgeCaptureLevel,
    selectSpaceContextLevel,
    selectUserTonePreset,
} from "../../app/settings/settingSlice";
import {
    getFullChatContextKeys,
    deduplicateContextKeys,
} from "../agent/getFullChatContextKeys";
import type { Agent, Category, SpaceContent, DialogConfig } from "../../app/types";
import type { Contexts } from "../types";
import { getModelContextWindow } from "../llm/getModelContextWindow";
import {
    selectCurrentUserBalance,
    selectUserId,
} from "../../auth/authSlice";
import {
    getModelPricing,
    getPrices,
    getFinalPrice,
    hasExplicitAgentPricing,
} from "../llm/getPricing";
import {
    buildStaticUserPolicyContext,
    resolveSpaceContextPreloadPlan,
} from "../policy/runtimePolicy";
import {
    PERSONALIZATION_DIALOG_CATEGORY,
    buildPersonalizationDialogPolicyContext,
} from "../policy/personalizationDialog";
import { buildEditingContextSummary } from "./buildEditingContext";
import { estimateTokenCount } from "../context/tokenUtils";
import type { OpenAIMessage } from "../../integrations/openai/filterAndCleanMessages";
import {
    ConversationLoad,
    planContextUsage,
} from "../context/retention";
import { TOOL_PACKS } from "../tools";
import { canonicalizeToolNames, prioritizeToolNames } from "../tools/toolNameAliases";
import {
    selectAllToolRuns,
} from "../tools/toolRunSlice";
import { buildRecentAppToolMemory } from "./appWorkingMemory";
import type { AgentRuntimeOptions } from "./types";
import { getModelConfig, getProviderByModelName, type Provider } from "../llm/providers";
import type { ImageGenerationState } from "../../chat/messages/types";
import { resolveToolBaseUrl } from "../tools/toolApiClient";

const BROWSER_UNAVAILABLE_CORE_TOOLS: Record<string, true> = {
    queryModelUsage: true,
    createAgentAutomation: true,
    notifyUser: true,
};

const getRuntimeCoreTools = (): string[] => {
    if (typeof window === "undefined") {
        return [...TOOL_PACKS.CORE];
    }
    return TOOL_PACKS.CORE.filter(
        (toolName) => !BROWSER_UNAVAILABLE_CORE_TOOLS[toolName],
    );
};

const isInlineVisualArtifactAgent = (agentConfig: Agent): boolean => {
    const tags = Array.isArray((agentConfig as any).tags)
        ? ((agentConfig as any).tags as unknown[])
        : [];
    return tags.some(
        (tag) =>
            typeof tag === "string" &&
            ["inline-artifact", "streaming-ui"].includes(tag)
    );
};

/**
 * 估算单条 OpenAI 消息的 token 数（包括 tool_calls）。
 */
export const estimateTokensOfMessage = (msg: OpenAIMessage): number => {
    let content = "";

    if (typeof msg.content === "string") {
        content = msg.content;
    } else if (Array.isArray(msg.content)) {
        content = msg.content
            .map((p: any) => {
                if (p.type === "text") return p.text || "";
                if (p.type === "image_url") return "[image]";
                return "[non-text]";
            })
            .join("");
    } else if (msg.content && typeof msg.content === "object") {
        content = JSON.stringify(msg.content);
    }

    let extraTokens = 0;
    if (Array.isArray((msg as any).tool_calls)) {
        const toolsStr = JSON.stringify((msg as any).tool_calls);
        extraTokens = estimateTokenCount(toolsStr);
    }

    return estimateTokenCount(content) + extraTokens;
};

/**
 * 基于最近 N 条消息的 token 分布，粗略评估会话负载等级。
 */
export const classifyConversationLoad = (
    messages: OpenAIMessage[],
): ConversationLoad => {
    const N = 20;
    if (!Array.isArray(messages) || messages.length === 0) return "light";

    const tail = messages.slice(-N);
    const tokenSamples = tail.map(estimateTokensOfMessage);
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

/**
 * 根据上下文窗口和对话摘要，对消息历史做截断。
 */
/**
 * 压缩历史 tool_result 内容，防止大体积工具返回值撑爆上下文。
 *
 * 策略：
 * - 最近一个 tool 轮次（最后一条 assistant tool_calls + 对应 tool 结果）：完整保留
 * - 更早的 tool 消息：内容截断到 MAX_CHARS，并追加截断标记
 *
 * 在 filterAndCleanMessages 之后、trimMessagesWithSummary 之前调用。
 */
export const compressOldToolResults = (
    messages: OpenAIMessage[],
    maxChars = 800,
): OpenAIMessage[] => {
    // 找到最后一条 assistant 消息（含 tool_calls）的索引
    let lastToolCallAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (
            messages[i].role === "assistant" &&
            Array.isArray((messages[i] as any).tool_calls) &&
            (messages[i] as any).tool_calls.length > 0
        ) {
            lastToolCallAssistantIdx = i;
            break;
        }
    }

    return messages.map((msg, idx) => {
        // 只处理 tool 消息，且不是最近轮次的
        if (msg.role !== "tool") return msg;
        if (idx > lastToolCallAssistantIdx) return msg; // 最近轮次，保留完整

        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (content.length <= maxChars) return msg;

        return {
            ...msg,
            content: content.slice(0, maxChars) + `\n…[截断，原始长度 ${content.length} 字符]`,
        };
    });
};


export const trimMessagesWithSummary = (
    messages: OpenAIMessage[],
    contextWindow: number,
    summaryTokenCount: number,
): OpenAIMessage[] => {
    const recentLoad = classifyConversationLoad(messages);

    const { rawMessageBudget, minTailTokens } = planContextUsage({
        contextWindow,
        summaryTokens: summaryTokenCount,
        recentLoad,
    });

    if (!Array.isArray(messages) || messages.length === 0) return messages;

    let totalTokens = 0;
    let keepCount = 0;

    // 从后往前保留，直到填满 rawMessageBudget
    for (let i = messages.length - 1; i >= 0; i--) {
        const t = estimateTokensOfMessage(messages[i]);
        if (totalTokens + t > rawMessageBudget) break;
        totalTokens += t;
        keepCount++;
    }

    if (keepCount >= messages.length) {
        return messages;
    }

    // 二次兜底：如果保留下来的 token 太少，尝试多保留几条，
    // 直到达到 minTailTokens，允许轻微超过 rawMessageBudget（最多 20%）。
    if (totalTokens < minTailTokens) {
        const maxBudgetWithSlack = rawMessageBudget * 1.2;
        for (let i = messages.length - 1 - keepCount; i >= 0; i--) {
            const t = estimateTokensOfMessage(messages[i]);
            if (totalTokens + t > maxBudgetWithSlack) break;
            totalTokens += t;
            keepCount++;
            if (totalTokens >= minTailTokens) break;
        }
    }

    // 再兜一层底：至少保留 2 条消息（如果存在）
    if (keepCount === 0 && messages.length > 0) {
        keepCount = Math.min(2, messages.length);
    }

    let cutIndex = messages.length - keepCount;
    if (cutIndex < 0) cutIndex = 0;

    // 避免从 tool 消息中间开始，丢失其调用方 assistant
    while (cutIndex < messages.length && messages[cutIndex].role === "tool") {
        cutIndex++;
    }

    return messages.slice(cutIndex);
};

/**
 * 安全读取数据库记录，失败时返回 null。
 */
export const readSafe = async <T>(
    dispatch: any,
    dbKey: string,
): Promise<T | null> => {
    try {
        return (await dispatch(read({
            dbKey: dbKey
        })).unwrap()) as T;
    } catch {
        return null;
    }
};

/** 将 Map 的所有 value 拼接为一个字符串 */
export const joinMapValues = (map: Map<string, string>): string =>
    Array.from(map.values()).join("");

/** 检查 OpenAI 消息数组中是否包含 image_url 片段 */
export const hasImageInMessages = (messages: any[]): boolean => {
    if (!Array.isArray(messages)) return false;

    return messages.some((msg) => {
        const content = (msg as any).content;
        if (!Array.isArray(content)) return false;

        return content.some(
            (part: any) =>
                part &&
                typeof part === "object" &&
                part.type === "image_url" &&
                part.image_url &&
                typeof part.image_url.url === "string" &&
                part.image_url.url.trim() !== "",
        );
    });
};

/** 根据 pendingFiles 和 currentInputMap 构造“当前输入上下文”字符串 */
export const formatCurrentInputContext = (
    pendingFiles: PendingFile[],
    currentInputMap: Map<string, string>,
): string => {
    if (pendingFiles.length === 0 || currentInputMap.size === 0) {
        return joinMapValues(currentInputMap);
    }

    const relevantPendingFiles = pendingFiles.filter((file) => {
        const key = file.sourceDialogKey || file.dialogKey || file.pageKey;
        return key && currentInputMap.has(key);
    });

    if (relevantPendingFiles.length === 0) {
        return joinMapValues(currentInputMap);
    }

    const filesByGroup = new Map<string, PendingFile[]>();
    for (const file of relevantPendingFiles) {
        const groupKey = file.groupId || file.id;
        const group = filesByGroup.get(groupKey);
        if (group) {
            group.push(file);
        } else {
            filesByGroup.set(groupKey, [file]);
        }
    }

    let sourceCounter = 1;
    let output = "";

    filesByGroup.forEach((filesInGroup) => {
        const isGroup = filesInGroup.length > 1;
        const sourceName = isGroup
            ? filesInGroup[0].name.split(" (")[0]
            : filesInGroup[0].name;

        output += `--- Source ${sourceCounter}: "${sourceName}" ---\n`;

        filesInGroup.forEach((file) => {
            const key = file.sourceDialogKey || file.dialogKey || file.pageKey;
            if (!key) return; // Skip if no key
            const content = currentInputMap.get(key);
            if (!content) return;

            if (isGroup) {
                output += `### Document: "${file.name}"\n${content}\n`;
            } else {
                output += `${content}\n`;
            }
        });

        output += `--- End of Source ${sourceCounter} ---\n\n`;
        sourceCounter++;
    });

    return output;
};

/** 校验当前用户是否有权限使用该 Agent，并且余额是否充足（每轮调用） */
export const validateAccessAndBalance = (
    agentConfig: Agent,
    state: RootState,
): string | null => {
    const userBalance = selectCurrentUserBalance(state);
    const currentUserId = selectUserId(state);

    const isCustomApi = agentConfig.apiSource === "custom";
    const isCliApi = agentConfig.apiSource === "cli";
    // M3: device-local owner when logged out; account match when logged in.
    const isDeviceLocalOwner =
        agentConfig.userId === "local" && !currentUserId;
    const isOwner =
        isDeviceLocalOwner ||
        (Boolean(currentUserId) && agentConfig.userId === currentUserId);

    if (!isOwner) {
        const hasWhitelist =
            Array.isArray(agentConfig.whitelist) &&
            agentConfig.whitelist.length > 0;

        if (hasWhitelist) {
            const isUserInWhitelist =
                !!currentUserId && agentConfig.whitelist?.includes(currentUserId);

            if (!isUserInWhitelist) {
                return "您不在该应用的白名单中，无法使用。";
            }
        }
    }

    // M3: custom/cli (and local-owner non-platform) skip balance before the
    // "balance is still loading" gate so logged-out local runs are not blocked.
    if (isCustomApi || isCliApi) {
        return null;
    }
    // Local-owner agents without explicit platform apiSource are treated as
    // non-platform for the balance gate (credentials live on-device).
    const isPlatformApi =
        agentConfig.apiSource === "platform" ||
        agentConfig.useServerProxy === true;
    if (isDeviceLocalOwner && !isPlatformApi) {
        return null;
    }

    if (typeof userBalance !== "number") {
        // Platform path without balance: ask for login instead of a false "loading" state.
        // Prefer the session object over selectors alone so parallel test mocks of
        // `selectUserId` cannot mis-classify a logged-out client as "balance loading".
        const hasSessionUser = Boolean(
            (state as { auth?: { currentUser?: { userId?: string } | null } })
                ?.auth?.currentUser?.userId,
        );
        if (!currentUserId || !hasSessionUser) {
            return "请登录后使用平台模型，或改用本地自定义/API/CLI Agent。";
        }
        return "正在获取用户余额，请稍候...";
    }

    const serverPrices = getModelPricing(agentConfig.provider || "", agentConfig.model);

    if (!serverPrices && !hasExplicitAgentPricing(agentConfig)) {
        return "无法获取模型定价信息，请稍后重试。";
    }

    const prices = getPrices(agentConfig, serverPrices ?? null);
    const maxPrice = getFinalPrice(prices);

    if (userBalance < maxPrice) {
        return "余额不足，请充值后再试。";
    }

    return null;
};

/** 静态上下文：Loop 期间稳定不变的部分 */
export interface StaticContexts {
    botInstructionsContext: string;
    botKnowledgeContext: string;
    spaceContext: string | null;
    userGlobalPrompt: string | null;
    userPolicyContext: string | null;
}

/** 动态上下文：每轮 Loop 需要更新的部分 */
export interface DynamicContexts {
    currentInputContext: string | null;
    historyContext: string;
    editingContext: string | null;
    appWorkingMemory: string | null;
    memoryOverlay: string | null;
    dialogSummary: string | null;
    proactiveSummary: string | null;
    referenceKeys: string[];
}

export const fetchMemoryOverlayContext = async (
    state: RootState,
    agentConfig: Agent,
    userInput: string | any[],
    dialogConfig?: DialogConfig,
): Promise<string | null> => {
    const token = typeof (state as any)?.auth?.currentToken === "string"
        ? (state as any).auth.currentToken
        : null;
    const currentServer = typeof (state as any)?.settings?.currentServer === "string"
        ? (state as any).settings.currentServer
        : null;
    const agentKey = typeof agentConfig.dbKey === "string" && agentConfig.dbKey.trim()
        ? agentConfig.dbKey.trim()
        : "";
    if (!token || !currentServer || !agentKey) return null;

    const baseUrl = resolveToolBaseUrl(currentServer);
    if (!baseUrl) return null;

    const inputText = typeof userInput === "string"
        ? userInput
        : JSON.stringify(userInput ?? "");
    const spaceId =
        typeof (dialogConfig as any)?.spaceId === "string" && (dialogConfig as any).spaceId.trim()
            ? (dialogConfig as any).spaceId.trim()
            : (state as any)?.space?.viewMode === "all"
                ? undefined
                : typeof (state as any)?.space?.currentSpaceId === "string" && (state as any).space.currentSpaceId.trim()
                    ? (state as any).space.currentSpaceId.trim()
                    : undefined;

    try {
        const response = await fetch(`${baseUrl}/api/memory/query`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
                agentKey,
                userInput: inputText,
                ...(spaceId ? { spaceId } : {}),
            }),
        });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null);
        return typeof payload?.promptBlock === "string" && payload.promptBlock.trim()
            ? payload.promptBlock.trim()
            : null;
    } catch {
        return null;
    }
};


/**
 * 构建静态上下文（Loop 外调用一次）
 * 包含：botInstructions、botKnowledge、spaceContext、userGlobalPrompt
 * 这些内容在 Agent Loop 期间是稳定的，不需要每轮重新构建
 */
export const buildStaticContexts = async (
    state: RootState,
    dispatch: any,
    agentConfig: Agent,
    dialogConfig?: DialogConfig,
    referenceContentCache?: Map<string, any>,
): Promise<StaticContexts> => {
    // 获取上下文 keys
    const keySets = await getFullChatContextKeys(
        state,
        dispatch,
        agentConfig,
        "", // 静态上下文不需要 userInput
        undefined, // 静态上下文不需要 dialogConfig
    );
    const finalKeys = deduplicateContextKeys(keySets);

    const fetchReferences = (keys: string[]) =>
        fetchReferenceContents(keys, dispatch, {
            format: "simplified_markdown",
            inlineMentionMeta: true,
            preloaded: referenceContentCache,
        });

    // 并行获取静态引用内容
    const [botInstructionsMap, botKnowledgeMap] = await Promise.all([
        fetchReferences(finalKeys.botInstructionsContext),
        fetchReferences(finalKeys.botKnowledgeContext),
    ]);

    // 构建 spaceContext
    const globalPrompt = selectGlobalPrompt(state);
    const userTonePreset = selectUserTonePreset(state);
    const knowledgeCaptureLevel = selectKnowledgeCaptureLevel(state);
    const spaceContextLevel = selectSpaceContextLevel(state);
    const currentSpace = selectCurrentSpace(state);
    const userRecentLimit = selectAiRecentContentLimit(state);
    const contextWindow = getModelContextWindow(agentConfig.model) || 128000;
    const preloadPlan = resolveSpaceContextPreloadPlan(spaceContextLevel);
    const dynamicLimit = Math.floor((contextWindow * preloadPlan.preloadBudgetRatio) / 150);
    const recentLimit = preloadPlan.includeRecentContent
        ? Math.max(3, Math.min(userRecentLimit, Math.max(3, dynamicLimit)))
        : 0;

    let spaceContext: string | null = null;

    if (currentSpace && spaceContextLevel > 1) {
        const { categories, contents } = currentSpace;
        const catEntries = Object.entries(categories || {}) as Array<
            [string, Category | null]
        >;
        const validCatList = catEntries
            .filter((entry) => entry[1] !== null)
            .map((entry) => [entry[0], entry[1] as Category] as const)
            .sort((a, b) => (a[1].order || 0) - (b[1].order || 0));

        const catMap = new Map<string, string>();
        let struct = "Directory Structure (Categories):\n";
        if (validCatList.length === 0) struct += "(No categories defined)\n";

        validCatList.forEach(([id, cat]) => {
            catMap.set(id, cat.name);
            struct += `- ${cat.name} (ID: ${id})\n`;
        });

        const contentEntries = Object.entries(contents || {}) as Array<
            [string, SpaceContent | null]
        >;
        const contentList = recentLimit > 0
            ? contentEntries
                .filter((entry) => entry[1] !== null)
                .map((entry) => entry[1] as SpaceContent)
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, recentLimit)
            : [];

        if (contentList.length > 0) {
            struct += `\nRecent Contents (Top ${recentLimit}):\n`;
            contentList.forEach((c) => {
                const item = c as SpaceContent;
                const catName = item.categoryId
                    ? catMap.get(item.categoryId) || "Unknown"
                    : "Uncategorized";
                struct += `- [${item.type}] ${item.title} (Category: ${catName}, dbKey: ${item.contentKey})\n`;
            });
        }

        spaceContext = `Space Title: ${currentSpace.name}\nSpace ID: ${currentSpace.id}\nDescription: ${currentSpace.description || "N/A"}\n\n${struct}`;
    }

    // 处理 linkedSpaces
    const linkedSpaceIds = agentConfig.linkedSpaces || [];
    if (linkedSpaceIds.length > 0 && spaceContextLevel > 1) {
        const linkedSpacesInfo: string[] = [];

        for (const spaceId of linkedSpaceIds) {
            const spaceKey = createSpaceKey.space(spaceId);
            const spaceData = await readSafe<any>(dispatch, spaceKey);
            if (spaceData) {
                const name = spaceData.name || spaceId;
                const desc = spaceData.description || "";
                linkedSpacesInfo.push(
                    `- ${name} (ID: ${spaceId})${desc ? `: ${desc}` : ""}`,
                );
            } else {
                linkedSpacesInfo.push(`- [无法访问] ${spaceId}`);
            }
        }

        if (linkedSpacesInfo.length > 0) {
            const linkedSection =
                `\n\n--- 关联空间 (Linked Spaces) ---\n` +
                `以下是 Agent 可访问的其他工作空间（粗略上下文）：\n` +
                linkedSpacesInfo.join("\n") +
                `\n\n提示：如需查询这些空间的详细内容，可使用 read 工具配合对应的 dbKey。`;

            spaceContext = (spaceContext || "") + linkedSection;
        }
    }

    // 当前仓库里只有 personalization 这一类“特殊流程对话”需要在普通 agent 之外
    // 额外追加工具/策略约束，因此先按 dialog category 做最小分流。
    // 如果未来出现多个稳定存在的流程型入口（例如 onboarding / agent-authoring / skill-authoring），
    // 再考虑把这层升级成统一的 dialog mode 抽象。
    const dialogPolicyContext =
        dialogConfig?.category === PERSONALIZATION_DIALOG_CATEGORY
            ? buildPersonalizationDialogPolicyContext()
            : null;

    return {
        botInstructionsContext: joinMapValues(botInstructionsMap),
        botKnowledgeContext: joinMapValues(botKnowledgeMap),
        spaceContext,
        userGlobalPrompt: globalPrompt,
        userPolicyContext: [
            buildStaticUserPolicyContext({
                agentConfig,
                settingsRecord: {
                    userTonePreset,
                    knowledgeCaptureLevel,
                    spaceContextLevel,
                    enableReadCurrentSpace: spaceContextLevel > 1,
                },
            }),
            dialogPolicyContext,
        ]
            .filter(Boolean)
            .join("\n"),
    };
};

/**
 * 构建动态上下文（每轮 Loop 调用）
 * 包含：currentInput、history、editingContext、dialogSummary
 * 这些内容可能每轮变化，需要实时更新
 */
export const buildDynamicContexts = async (
    state: RootState,
    dispatch: any,
    agentConfig: Agent,
    userInput: string | any[],
    runtimeOptions?: AgentRuntimeOptions,
    referenceContentCache?: Map<string, any>,
    dialogKey?: string,
): Promise<DynamicContexts> => {
    // 读取 dialog summary 和 config
    let dialogSummary: string | null = null;
    let dialogConfig: DialogConfig | undefined;
    if (dialogKey) {
        dialogConfig = selectById(state, dialogKey) as DialogConfig | undefined;
        if (dialogConfig?.summary) {
            dialogSummary = dialogConfig.summary;
        }
    }

    const keySets = await getFullChatContextKeys(
        state,
        dispatch,
        agentConfig,
        userInput,
        dialogConfig,
    );
    const finalKeys = deduplicateContextKeys(keySets);

    const fetchReferences = (keys: string[]) =>
        fetchReferenceContents(keys, dispatch, {
            format: "simplified_markdown",
            inlineMentionMeta: true,
            preloaded: referenceContentCache,
        });

    // 只获取动态引用内容
    const [currentInputMap, historyMap] = await Promise.all([
        fetchReferences(finalKeys.currentInputContext),
        fetchReferences(finalKeys.historyContext),
    ]);

    const pendingFiles = selectPendingFiles(state);
    const formattedCurrentInputContext = formatCurrentInputContext(
        pendingFiles,
        currentInputMap,
    );

    const dialogId = dialogConfig?.id ?? null;
    const currentDialogMessages = selectAllMsgs(state, dialogId);
    const currentDialogMessageIds = new Set(currentDialogMessages.map((msg) => msg.id));
    const currentDialogToolRuns = selectAllToolRuns(state).filter((run) =>
        currentDialogMessageIds.has(run.messageId)
    );

    const editingContext = buildEditingContextSummary(state, runtimeOptions);
    const appWorkingMemory = buildRecentAppToolMemory(
        currentDialogMessages,
        currentDialogToolRuns,
    );
    const memoryOverlay = await fetchMemoryOverlayContext(
        state,
        agentConfig,
        userInput,
        dialogConfig,
    );

    return {
        currentInputContext: formattedCurrentInputContext.trim() || null,
        historyContext: joinMapValues(historyMap),
        editingContext,
        appWorkingMemory,
        memoryOverlay,
        dialogSummary,
        proactiveSummary: dialogConfig?.proactiveSummary || null,
        referenceKeys: dialogConfig?.referenceKeys || [],
    };
};

/**
 * 合并静态和动态上下文为完整的 Contexts 对象
 */
export const mergeContexts = (
    staticCtx: StaticContexts,
    dynamicCtx: DynamicContexts,
): Contexts => ({
    botInstructionsContext: staticCtx.botInstructionsContext || undefined,
    botKnowledgeContext: staticCtx.botKnowledgeContext || undefined,
    spaceContext: staticCtx.spaceContext || undefined,
    userGlobalPrompt: staticCtx.userGlobalPrompt || undefined,
    userPolicyContext: staticCtx.userPolicyContext || undefined,
    currentInputContext: dynamicCtx.currentInputContext,
    historyContext: dynamicCtx.historyContext || undefined,
    editingContext: dynamicCtx.editingContext,
    appWorkingMemory: dynamicCtx.appWorkingMemory,
    memoryOverlay: dynamicCtx.memoryOverlay,
    dialogSummary: dynamicCtx.dialogSummary,
    proactiveSummary: dynamicCtx.proactiveSummary,
    referenceKeys: dynamicCtx.referenceKeys,
});

/** 合并 Agent.tools + Context Page Tools + Mentioned Tools + runtimeOptions.extraTools */
export const mergeAgentToolsWithRuntime = (
    agentConfig: Agent,
    referencedTools: string[],
    mentionedTools: string[],
    runtimeOptions?: AgentRuntimeOptions,
    state?: RootState,
): Agent => {
    const rawBaseTools = Array.isArray((agentConfig as any).tools)
        ? ((agentConfig as any).tools as string[])
        : [];
    const baseTools = canonicalizeToolNames(rawBaseTools);
    const requiredSkillTools = canonicalizeToolNames(
        (agentConfig as any).referencedTools ?? []
    );
    const recommendedSkillTools = canonicalizeToolNames(
        (agentConfig as any).recommendedSkillTools ?? []
    );
    const recommendedSkillHints = Array.from(
        new Set(
            ((agentConfig as any).recommendedSkillHints ?? []).filter(
                (item: unknown): item is string =>
                    typeof item === "string" && item.trim().length > 0,
            ),
        ),
    );
    const skillPromptPatches = Array.from(
        new Set(
            ((agentConfig as any).skillPromptPatches ?? []).filter(
                (item: unknown): item is string =>
                    typeof item === "string" && item.trim().length > 0,
            ),
        ),
    );
    const enhancedTools = new Set<string>([
        ...baseTools,
        ...(isInlineVisualArtifactAgent(agentConfig) ? [] : getRuntimeCoreTools()),
        ...(baseTools.length > 0 && !isInlineVisualArtifactAgent(agentConfig)
            ? TOOL_PACKS.LIGHT_WEB
            : []),
        ...(isInlineVisualArtifactAgent(agentConfig) ? [] : requiredSkillTools),
        ...(isInlineVisualArtifactAgent(agentConfig)
            ? []
            : canonicalizeToolNames(referencedTools)),
        ...(isInlineVisualArtifactAgent(agentConfig)
            ? []
            : canonicalizeToolNames(mentionedTools)),
    ]);

    // Intelligence: If user explicitly added ANY browser tool, auto-inject the FULL browser pack
    const hasAnyBrowserTool = baseTools.some((t) => t.startsWith("browser_"));
    if (hasAnyBrowserTool) {
        TOOL_PACKS.FULL_BROWSER.forEach((t) => enhancedTools.add(t));
    }

    const extraTools = isInlineVisualArtifactAgent(agentConfig)
        ? []
        : canonicalizeToolNames(runtimeOptions?.extraTools ?? []);
    for (const t of extraTools) {
        enhancedTools.add(t);
    }

    if (!isInlineVisualArtifactAgent(agentConfig)) {
        const viewMode = state ? selectViewMode(state) : "categories";
        if (viewMode === "all") {
            enhancedTools.delete("search_workspace");
            enhancedTools.add("search_all_spaces");
        } else {
            enhancedTools.delete("search_all_spaces");
            enhancedTools.add("search_workspace");
        }
    }

    return {
        ...agentConfig,
        tools: prioritizeToolNames(
            Array.from(enhancedTools),
            recommendedSkillTools,
        ),
        recommendedSkillTools,
        recommendedSkillHints,
        skillPromptPatches,
    };
};

/** 应用本轮图片配置 override */
export const applyImageConfigRuntimeOverride = (
    agentConfig: Agent,
    runtimeOptions?: AgentRuntimeOptions,
): Agent => {
    const override = runtimeOptions?.imageConfigOverride;
    if (!override) {
        return agentConfig;
    }

    const baseImageConfig = (agentConfig as any).imageConfig ?? {};

    return {
        ...agentConfig,
        ...(override.imageModelOverride
            ? { model: override.imageModelOverride }
            : {}),
        imageConfig: {
            ...baseImageConfig,
            ...override,
        },
    };
};

const formatImageWaitHint = (
    range?: {
        min: number;
        max: number;
    },
) => {
    if (!range || typeof range.min !== "number" || typeof range.max !== "number") {
        return undefined;
    }
    return `通常需要 ${range.min}-${range.max} 秒`;
};

const resolveAgentImageModelIdentity = (agentConfig: Partial<Agent>) => {
    let providerKey = (agentConfig.provider || "").toLowerCase();
    let modelName = agentConfig.model ?? "";

    if (modelName.includes("/")) {
        const slash = modelName.indexOf("/");
        if (!providerKey) providerKey = modelName.slice(0, slash);
        modelName = modelName.slice(slash + 1);
    }

    try {
        return {
            providerKey,
            modelConfig: getModelConfig(providerKey as Provider, modelName),
        };
    } catch {
        try {
            const detected = getProviderByModelName(modelName);
            if (!detected) {
                return { providerKey, modelConfig: null };
            }
            return {
                providerKey: detected,
                modelConfig: getModelConfig(detected, modelName),
            };
        } catch {
            return { providerKey, modelConfig: null };
        }
    }
};

export const resolveImageGenerationStreamingState = (
    agentConfig: Agent,
    args?: {
        stage?: ImageGenerationState["stage"];
        previous?: ImageGenerationState | null;
    },
): ImageGenerationState | undefined => {
    const { modelConfig } = resolveAgentImageModelIdentity(agentConfig);
    const hasImageOutput =
        !!(modelConfig?.hasImageOutput ?? (modelConfig as any)?.supportsImageOutput) ||
        agentConfig.imageConfig?.enabled === true;
    if (!hasImageOutput) {
        return undefined;
    }

    const currentProfile = modelConfig?.imageGenerationProfiles?.find(
        (profile) => profile.imageModel === modelConfig.name,
    );

    return {
        kind: "image_generation",
        stage: args?.stage ?? args?.previous?.stage ?? "submitted",
        startedAt: args?.previous?.startedAt ?? Date.now(),
        waitHint:
            formatImageWaitHint(modelConfig?.imageGenerationWaitTimeSeconds) ??
            "通常需要几十秒",
        profileLabel: currentProfile?.label,
    };
};
