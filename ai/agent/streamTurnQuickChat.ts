// packages/ai/agent/streamTurnQuickChat.ts
//
// Quick-chat 专用逻辑：agent config 读取超时、动态上下文超时空回退、
// 直答检测（禁用 tools）、错误分类、turn 失败收尾。
//
// 从 streamAgentChatTurn.ts 提取——quick-chat 路径的性能优化与降级策略。
// 非 quick-chat 路径（quickChatPerfStartedAt 为 undefined）直接走原始逻辑。

import { isResponseAPIModel } from "../llm/isResponseAPIModel";
import { createDialogMessageKeyAndId } from "../../database/keys";
import { messageStreamEnd } from "../../chat/messages/messageSlice";
import { buildDynamicContexts, buildStaticContexts } from "./streamAgentChatTurnUtils";
import { read } from "../../database/dbSlice";
import { extractCustomId } from "../../core/prefix";
import { prepareTools } from "../tools/prepareTools";
import type { Agent, DialogConfig } from "../../app/types";
import type { RootState } from "../../app/store";
import type { AgentRuntimeOptions } from "./types";

export const QUICK_CHAT_AGENT_CONFIG_READ_TIMEOUT_MS = 10_000;
export const QUICK_CHAT_DYNAMIC_CONTEXT_TIMEOUT_MS = 5_000;

export const EMPTY_DYNAMIC_CONTEXTS = {
    currentInputContext: null,
    historyContext: "",
    editingContext: null,
    appWorkingMemory: null,
    memoryOverlay: null,
    dialogSummary: null,
    proactiveSummary: null,
    referenceKeys: [],
};

export const logQuickChatPerfStage = (
    startedAt: number | undefined,
    stage: string,
    details: Record<string, unknown> = {},
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

export const readAgentConfigForTurn = async (
    dispatch: any,
    agentKey: string,
    quickChatPerfStartedAt?: number,
): Promise<Agent> => {
    const readPromise = dispatch(read({ dbKey: agentKey })).unwrap() as Promise<Agent>;
    if (!quickChatPerfStartedAt) return readPromise;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            readPromise,
            new Promise<Agent>((_, reject) => {
                timeoutId = setTimeout(() => {
                    logQuickChatPerfStage(
                        quickChatPerfStartedAt,
                        "quick-chat-agent-config-read-timeout",
                        { agentKey, timeoutMs: QUICK_CHAT_AGENT_CONFIG_READ_TIMEOUT_MS },
                    );
                    reject(
                        new Error("读取 Agent 配置超时，未能启动模型回复。"),
                    );
                }, QUICK_CHAT_AGENT_CONFIG_READ_TIMEOUT_MS);
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

// Need read from dbSlice

export const buildDynamicContextsForTurn = async (
    state: RootState,
    dispatch: any,
    agentConfig: Agent,
    userInput: string | any[],
    runtimeOptions: AgentRuntimeOptions | undefined,
    mergedContentCache: Map<string, any>,
    dialogKey: string | undefined,
    quickChatPerfStartedAt?: number,
) => {
    if (!quickChatPerfStartedAt) {
        return buildDynamicContexts(
            state,
            dispatch,
            agentConfig,
            userInput,
            runtimeOptions,
            mergedContentCache,
            dialogKey,
        );
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeoutPromise = new Promise<typeof EMPTY_DYNAMIC_CONTEXTS>((resolve) => {
            timeoutId = setTimeout(() => {
                logQuickChatPerfStage(
                    quickChatPerfStartedAt,
                    "quick-chat-dynamic-context-timeout",
                    { agentKey: agentConfig.dbKey, dialogKey, timeoutMs: QUICK_CHAT_DYNAMIC_CONTEXT_TIMEOUT_MS },
                );
                resolve(EMPTY_DYNAMIC_CONTEXTS);
            }, QUICK_CHAT_DYNAMIC_CONTEXT_TIMEOUT_MS);
        });
        logQuickChatPerfStage(
            quickChatPerfStartedAt,
            "stream-agent-dynamic-context-starting",
            { responseApi: isResponseAPIModel(agentConfig) },
        );
        const contextPromise = buildDynamicContexts(
            state,
            dispatch,
            agentConfig,
            userInput,
            runtimeOptions,
            mergedContentCache,
            dialogKey,
        );
        return await Promise.race([
            contextPromise,
            timeoutPromise,
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
};

export const finalizeQuickChatAgentTurnFailure = async (
    dispatch: any,
    dialogKey: string,
    agentKey: string,
    error: unknown,
) => {
    const dialogId = extractCustomId(dialogKey);
    const { key: msgKey, messageId } = createDialogMessageKeyAndId(dialogId);
    const reason =
        error instanceof Error && error.message.trim()
            ? error.message.trim()
            : typeof error === "string" && error.trim()
                ? error.trim()
                : error && typeof error === "object"
                    && typeof (error as { message?: unknown }).message === "string"
                    && (error as { message: string }).message.trim()
                    ? (error as { message: string }).message.trim()
                    : "未能启动模型回复，请重试。";
    await dispatch(
        messageStreamEnd({
            finalContentBuffer: [
                { type: "text", text: `[错误: ${reason}]` },
            ],
            totalUsage: null,
            msgKey,
            agentConfig: { dbKey: agentKey },
            dialogId,
            dialogKey,
            messageId,
            reasoningBuffer: "",
        }),
    ).unwrap?.();
};

// Need extractCustomId

export const normalizeAgentRunUserInput = (userInput: string | any[]) => {
    if (typeof userInput === "string") return userInput;
    if (!Array.isArray(userInput)) return "";
    return userInput.filter((part) => {
        if (!part || typeof part !== "object") return false;
        if (part.type === "text") return typeof part.text === "string";
        return (
            part.type === "image_url"
            && typeof part.image_url?.url === "string"
            && !!part.image_url.url.trim()
        );
    });
};

export const isSimpleTextInput = (userInput: string | any[]) => {
    if (typeof userInput === "string") return true;
    if (!Array.isArray(userInput)) return false;
    return userInput.every(
        (part) => part && typeof part === "object"
            && part.type === "text"
            && typeof part.text === "string",
    );
};

export const canUseQuickChatEmptyDynamicContexts = (
    quickChatPerfStartedAt: number | undefined,
    userInput: string | any[],
    runtimeOptions: AgentRuntimeOptions | undefined,
    dialogConfig: DialogConfig | null,
    agentConfig?: Agent | null,
) => {
    if (!quickChatPerfStartedAt) return false;
    if (runtimeOptions) return false;
    if (agentConfig?.tools?.includes("rememberMemory")) return false;
    if (!isSimpleTextInput(userInput)) return false;
    if (dialogConfig?.referenceKeys?.length) return false;
    return true;
};

const QUICK_CHAT_DIRECT_ANSWER_PATTERN = /(只回复|只输出|只回答|直接回复|直接回答|不要解释|无需解释|不用解释|简短回答|一句话)/i;
const QUICK_CHAT_TOOL_INTENT_PATTERN = /(调用|转交|agent|助手|应用|网页|页面|图表|图片|生成图|画图|删除|清理|空间|商品|链接|https?:\/\/|www\.|@)/i;

export const shouldDisableQuickChatToolsForDirectAnswer = (
    quickChatPerfStartedAt: number | undefined,
    userInput: string | any[],
    runtimeOptions: AgentRuntimeOptions | undefined,
    dialogConfig: DialogConfig | null,
) => {
    if (!canUseQuickChatEmptyDynamicContexts(
        quickChatPerfStartedAt,
        userInput,
        runtimeOptions,
        dialogConfig,
        undefined,
    )) {
        return false;
    }
    const text = extractAgentRunUserText(userInput);
    if (!text || text.length > 500) return false;
    if (!QUICK_CHAT_DIRECT_ANSWER_PATTERN.test(text)) return false;
    return !QUICK_CHAT_TOOL_INTENT_PATTERN.test(text);
};

export const classifyQuickChatAccessError = (accessError: string) => {
    if (accessError.includes("获取用户余额")) return "balance-loading";
    if (accessError.includes("余额")) return "balance";
    if (accessError.includes("白名单")) return "whitelist";
    if (accessError.includes("定价")) return "pricing";
    return "unknown";
};

export const isUsableAgentConfig = (value: unknown): value is Agent =>
    !!value
    && typeof value === "object"
    && (value as any).__ssrPreviewOnly !== true
    && typeof (value as Agent).dbKey === "string"
    && !!(value as Agent).dbKey
    && typeof (value as Agent).model === "string"
    && !!(value as Agent).model
    && typeof (value as Agent).provider === "string"
    && !!(value as Agent).provider;

export const extractAgentRunUserText = (userInput: string | any[]): string => {
    if (typeof userInput === "string") return userInput.trim();
    if (!Array.isArray(userInput)) return "";
    return userInput
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
        .trim();
};

export const hasAgentRunUserInputContent = (userInput: string | any[]) => {
    if (typeof userInput === "string") return userInput.trim().length > 0;
    return Array.isArray(userInput) && userInput.length > 0;
};

export const isLastMessageMatchingUserInput = (visibleMessages: any[], userInput: any): boolean => {
    if (visibleMessages.length === 0) return false;
    const lastMsg = visibleMessages[visibleMessages.length - 1];
    if (lastMsg.role !== "user") return false;

    const content1 = lastMsg.content;
    const content2 = userInput;

    const normalize = (content: any) => {
        if (typeof content === "string") return content.trim();
        if (Array.isArray(content)) {
            if (content.length === 1 && content[0]?.type === "text") {
                return (content[0].text || "").trim();
            }
            return content.map(part => {
                if (part?.type === "text") return { type: "text", text: part.text?.trim() };
                if (part?.type === "image_url") return { type: "image_url", url: part.image_url?.url };
                return part;
            });
        }
        return content;
    };

    const norm1 = normalize(content1);
    const norm2 = normalize(content2);

    if (typeof norm1 === "string" && typeof norm2 === "string") {
        return norm1 === norm2;
    }
    return JSON.stringify(norm1) === JSON.stringify(norm2);
};

export const setLoopStopReason = (reason: string) => {
    const w =
        typeof globalThis !== "undefined" && (globalThis as any).window
            ? (globalThis as any).window
            : null;
    if (w) w.__LOOP_STOP_REASON__ = reason;
};

/**
 * Warm prepareTools cache while static context is building so the first
 * provider request does not pay full schema translate/clone on the critical path.
 * Failures are ignored — sendOpenAI* will prepare tools again if needed.
 */
export const prewarmPreparedToolsForAgent = (agentConfig: Agent) => {
    const tools = (agentConfig as any)?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return;
    try {
        prepareTools(tools, { provider: (agentConfig as any).provider });
    } catch {
        // ignore prewarm errors
    }
};


export const buildStaticContextsWithToolsPrewarm = async (
    state: RootState,
    dispatch: any,
    agentConfig: Agent,
    currentDialog: DialogConfig | null | undefined,
    mergedContentCache: Map<string, any>,
) => {
    const [staticContexts] = await Promise.all([
        buildStaticContexts(
            state,
            dispatch,
            agentConfig,
            currentDialog ?? undefined,
            mergedContentCache,
        ),
        Promise.resolve().then(() => prewarmPreparedToolsForAgent(agentConfig)),
    ]);
    return staticContexts;
};