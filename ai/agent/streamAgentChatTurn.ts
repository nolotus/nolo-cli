// 文件路径: packages/ai/agent/streamAgentChatTurn.ts
import { isAbortError } from "../../core/abortError";
import { isRecord } from "../../core/isRecord";
import { extractCustomId } from "../../core/prefix";
import { toErrorMessage } from "../../core/errorMessage";
import { asOptionalTrimmedString } from "../../core/optionalString";
import { asRecordOrEmpty } from "../../core/recordOrEmpty";
import { asTrimmedString } from "../../core/trimmedString";
import { createDialogMessageKeyAndId } from "../../database/keys";
import { DataType } from "../../create/types";
import { isLiveAudioOnlyAgent } from "./isLiveAudioOnlyAgent";
import { projectDesktopToolUiContent } from "./projectDesktopToolUiContent";
import {
    attachToolCallIdToSegment,
    buildMinimalToolCallsFromIds,
    type DesktopAssistantSegment,
    resolveSegmentToolCalls,
    selectPersistableFinalizedSegments,
} from "./desktopTurnSegments";

import type { RootState } from "../../app/store";
import { patch, read, selectById, write } from "../../database/dbSlice";
import { generateRequestBody } from "../llm/generateRequestBody";
import {
    selectCurrentDialogConfig,
    selectDialogConfigByKey,
    addActiveController,
    removeActiveController,
    selectPendingUserInputQueue,
    dequeueUserInput,
    clearPendingUserInputQueue,
    selectActiveControllers,
    updateTokens,
} from "../../chat/dialog/dialogSlice";
import { runChatQueueTurnEnd } from "../../chat/queue/chatQueueLifecycleActions";
import {
    finalizeTransientMessageOnError,
    removeTransientMessage,
    selectAllMsgs,
} from "../../chat/messages/messageSlice";
import { persistToolMessages } from "../../chat/messages/persistToolMessage";
import {
    selectMaxExecutionTime,
    selectCurrentServer,
} from "../../app/settings/settingSlice";
import { filterAndCleanMessages } from "../../integrations/openai/filterAndCleanMessages";
import {
    getFullChatContextKeys,
    deduplicateContextKeys,
} from "../agent/getFullChatContextKeys";
import type { Agent, DialogConfig } from "../../app/types";
import { isResponseAPIModel } from "../llm/isResponseAPIModel";
import { getModelContextWindow } from "../llm/getModelContextWindow";
import { resolveAgentImageInputSupport } from "../llm/agentCapabilities";
import { resolveBuiltinPlatformAgentRecord } from "../../agent-runtime/builtinPlatformAgentConfigs";
import {
    resolveAgentCallPlan,
    resolveClientWire,
} from "../../agent-runtime/agentCallPlan";
import {
    selectResponsesConversationState,
    updateResponsesConversationState,
} from "../../agent-runtime/responsesConversationState";

import {
    sendOpenAICompletionsRequest,
    type CompletionMeta,
} from "../chat/sendOpenAICompletionsRequest";
import { sendOpenAIResponseRequest } from "../chat/sendOpenAIResponseRequest";

import type { AgentRuntimeOptions } from "./types";
import { buildAgentViewMessages } from "./cleanAgentMessages";
import { extractCategorizedMentions, type CategorizedMentions } from "../../create/editor/utils/slateUtils";
import { mergeReferences, resolveReferenceAssets, resolveToolsFromKeys } from "./referenceUtils";
import { applyQuickChatModelOverride } from "./quickChatModelOverride";
import { estimateTokenCount } from "../context/tokenUtils";
import {
    applyImageConfigRuntimeOverride,
    buildStaticContexts,
    compressOldToolResults,
    buildDynamicContexts,
    mergeContexts,
    hasImageInMessages,
    shouldRejectImageInputForAgent,
    mergeAgentToolsWithRuntime,
    resolveImageGenerationStreamingState,
    trimMessagesWithSummary,
    validateAccessAndBalance,
} from "./streamAgentChatTurnUtils";
import { buildCliPrompt } from "./cliPrompt";
import { createCliChatTurnStream } from "./cliChatClient";
import { getCliChatSession, startCliChatSession } from "./cliChatClient";
import {
    messageStreamEnd,
    messageStreaming,
    prepareAndPersistUserMessage,
} from "../../chat/messages/messageSlice";
import {
  selectIdentityToken,
  selectIdentityUser,
  selectIdentityUserId,
} from "identity/selectors";
import { shouldBlockForGptPro } from "../../auth/gptProTier";
import { persistMessageWithFixedId } from "./persistMessageWithFixedId";
import { updateTotalUsage } from "../chat/updateTotalUsage";
import { estimateMissingUsage } from "../token/missingUsageEstimate";
import { createSSEParser } from "../chat/parseMultilineSSE";
import { performServerProxyFetchWithRetry } from "../chat/serverProxyRetry";
import { normalizeServerOrigin } from "./serverOrigin";
import { getIsDesktopApp } from "../../app/utils/env";
import { runDesktopAgentRuntimeTurnStream } from "../../app/utils/desktopAgentRuntimeTurnClient";
import { prepareTools } from "../tools/prepareTools";

// ── extracted pure modules ──────────────────────────────────────────────
import {
    buildMessageMetadata,
    buildDesktopRuntimeToolMessagesForUi,
    toolMessageWillPersist,
    shouldUseDesktopLocalRuntime,
    resolveRemoteBoundMachineId,
    resolveWebAgentRuntimeToolSurface,
    formatMachineAgentRunError,
    patchDialogThreadMetadata,
    patchDialogActiveAgent,
    appendCliCapabilityWarnings,
} from "./streamTurnMessageBuild";
import {
    consumeAgentRunStream,
    type AgentRunStreamConsumeOutcome,
} from "./streamTurnStreamConsumer";
import {
    QUICK_CHAT_AGENT_CONFIG_READ_TIMEOUT_MS,
    QUICK_CHAT_DYNAMIC_CONTEXT_TIMEOUT_MS,
    EMPTY_DYNAMIC_CONTEXTS,
    logQuickChatPerfStage,
    readAgentConfigForTurn,
    buildDynamicContextsForTurn,
    finalizeQuickChatAgentTurnFailure,
    normalizeAgentRunUserInput,
    isSimpleTextInput,
    canUseQuickChatEmptyDynamicContexts,
    shouldDisableQuickChatToolsForDirectAnswer,
    classifyQuickChatAccessError,
    isUsableAgentConfig,
    extractAgentRunUserText,
    hasAgentRunUserInputContent,
    isLastMessageMatchingUserInput,
    setLoopStopReason,
    buildStaticContextsWithToolsPrewarm,
} from "./streamTurnQuickChat";

/** result 是否包含流内已执行的 toolCall（决定最后一段 content 不从 result.content 取）。 */
function hasInlineExecutedToolCalls(result: { output?: unknown } | null | undefined): boolean {
  const output = (result as { output?: Array<{ type?: string; result?: unknown }> } | null | undefined)?.output;
  return Array.isArray(output) && output.some((b) => b?.type === "toolCall" && b?.result != null);
}

/**
 * 共享处理器：把服务器端 /api/agent/run SSE 的工具事件
 * (assistant_tool_calls / tool_result) 投影成前端 tool message 并 dispatch。
 *
 * 用于 machine-bound 分支与远端代理分支——这两条分支消费的是服务器端 loop
 * 发出的事件（见 packages/core/agentRunStreamEvents.ts 与
 * packages/server/handlers/agentRun/loop.ts），而非桌面 local runtime 的
 * LocalAgentToolEvent。在引入本 helper 之前，两条分支只处理 text/done/error，
 * 导致 ask_user 等工具调用结果从不渲染成 tool 卡片。
 *
 * 对照桌面分支 (event.type === "tool") 的 activeToolMessages 模式：
 * - assistant_tool_calls：按 tool_calls 数组为每个 call 建一条 tool message
 *   (role:tool, content:"", isStreaming:true, toolName, toolCallId)，存入 Map
 *   并 dispatch messageStreaming；
 * - tool_result：用 toolCallId 从 Map 取出对应消息，更新 content
 *   (projectDesktopToolUiContent 投影)、isStreaming:false，再 dispatch。
 *
 * 返回一个带状态闭包的 onToolPayload 函数，供 consumeAgentRunStream 的
 * onPayload 内部调用。
 */
function createRemoteToolEventHandlers(opts: {
    dialogId: string;
    dispatch: (action: any) => any;
    messageMetadata: Record<string, unknown>;
}) {
    const { dialogId, dispatch, messageMetadata } = opts;
    const activeToolMessages = new Map<string, any>();

    const handleToolPayload = (payload: any) => {
        if (!payload || typeof payload !== "object") return;

        if (payload.type === "assistant_tool_calls") {
            const toolCalls = Array.isArray(payload.tool_calls)
                ? payload.tool_calls
                : [];
            for (const tc of toolCalls) {
                const callId = tc?.id;
                const toolName = tc?.function?.name;
                if (!callId || !toolName) continue;
                const { key: toolDbKey, messageId: toolMsgId } =
                    createDialogMessageKeyAndId(dialogId);
                const argsStr =
                    typeof tc.function?.arguments === "string"
                        ? tc.function.arguments
                        : "";
                const toolMsg = {
                    id: toolMsgId,
                    dialogId,
                    dbKey: toolDbKey,
                    role: "tool" as const,
                    content: "",
                    isStreaming: true,
                    toolName,
                    toolCallId: callId,
                    toolPayload: {
                        toolName,
                        status: "running" as const,
                        input: safeParseToolArgs(argsStr),
                        rawToolCall: tc,
                        summary: "",
                    },
                    ...messageMetadata,
                };
                activeToolMessages.set(callId, toolMsg);
                dispatch(messageStreaming(toolMsg));
            }
            return;
        }

        if (payload.type === "tool_result") {
            const callId = payload.toolCallId;
            if (!callId) return;
            const existing = activeToolMessages.get(callId);
            const toolName =
                asOptionalTrimmedString(payload.toolName) ||
                asOptionalTrimmedString(existing?.toolName) ||
                "tool";
            const mergedMeta = isRecord(payload.metadata)
                ? payload.metadata
                : undefined;
            const isToolError = !!mergedMeta?.error;
            const projectedContent = projectDesktopToolUiContent({
                toolName,
                content: payload.content,
                metadata: mergedMeta ?? undefined,
            });
            const resultStatus: "succeeded" | "failed" = isToolError ? "failed" : "succeeded";
            if (existing) {
                const updatedMsg = {
                    ...existing,
                    isStreaming: false,
                    content: projectedContent,
                    toolName,
                    toolPayload: {
                        ...(existing.toolPayload ?? {}),
                        toolName,
                        status: resultStatus,
                    },
                };
                activeToolMessages.set(callId, updatedMsg);
                dispatch(messageStreaming(updatedMsg));
            } else {
                // 没有 assistant_tool_calls 先到（理论上不应发生），兜底建一条
                const { key: toolDbKey, messageId: toolMsgId } =
                    createDialogMessageKeyAndId(dialogId);
                const toolMsg = {
                    id: toolMsgId,
                    dialogId,
                    dbKey: toolDbKey,
                    role: "tool" as const,
                    content: projectedContent,
                    isStreaming: false,
                    toolName,
                    toolCallId: callId,
                    toolPayload: {
                        toolName,
                        status: resultStatus,
                        input: {},
                        summary: "",
                    },
                    ...messageMetadata,
                };
                activeToolMessages.set(callId, toolMsg);
                dispatch(messageStreaming(toolMsg));
            }
        }
    };

    return { handleToolPayload, activeToolMessages };
}

/**
 * 把 remoteToolHandlers 维护的 tool 消息持久化（best-effort），并清理空内容行。
 * 与桌面分支 streamEnded/abort/error 三条路径同构：只有非空 content 的 tool 行
 * 才写库，空行从 store 移除避免留下占位卡片。
 */
async function persistRemoteToolMessagesAndCleanup(
    dispatch: (action: any) => any,
    activeToolMessages: Map<string, any>,
) {
    const durableTools: any[] = [];
    for (const toolMsg of activeToolMessages.values()) {
        const content = (toolMsg as any)?.content;
        const hasContent =
            typeof content === "string"
                ? content.trim().length > 0
                : Array.isArray(content) && content.length > 0;
        if (!hasContent) {
            dispatch(removeTransientMessage((toolMsg as any).id));
            continue;
        }
        const stopped = { ...toolMsg, isStreaming: false };
        dispatch(messageStreaming(stopped));
        durableTools.push(stopped);
    }
    await persistToolMessages(dispatch, durableTools, {
        isStreaming: false,
        soft: true,
    });
    // 清空 Map：允许 finally 兜底重复调用成为空操作（幂等），
    // 避免异常路径下重复 dispatch/persist 已处理的 tool 行。
    activeToolMessages.clear();
}

/** 解析 tool arguments JSON 字符串，失败时返回原始字符串。 */
function safeParseToolArgs(argsStr: string): any {
    if (!argsStr) return {};
    try {
        return JSON.parse(argsStr);
    } catch {
        return { raw: argsStr };
    }
}


/** streamAgentChatTurn 参数（聊天轮次专用） */
export interface StreamAgentChatTurnArgs {
    agentKey: string;
    /**
     * 本轮执行配置的直接来源。auto 档位对话由代码内置 profile 提供，传了就
     * 不再去读 `agentKey` 对应的记录——那条 `agent-pub-*` 记录按设计可以不
     * 存在（见 chat/dialog/dialogAgentPolicy 的 resolveDialogRuntimeAgentConfig）。
     */
    agentConfig?: Agent;
    userInput: string | any[];
    serverBase?: string;
    dialogKey?: string; // 可选。显式指定目标对话，不传则使用当前活跃对话。
    isStreaming?: boolean;
    parentMessageId?: string;
    runtimeOptions?: AgentRuntimeOptions;
    quickChatPerfStartedAt?: number;
}

export const streamAgentChatTurnHandler = async (
    args: StreamAgentChatTurnArgs,
    thunkApi: any,
) => {
    const {
        agentKey,
        agentConfig: providedAgentConfig,
        userInput,
        dialogKey: explicitDialogKey,
        parentMessageId,
        runtimeOptions,
        quickChatPerfStartedAt,
    } = args;
    const { getState, dispatch, rejectWithValue } = thunkApi;
    const state = getState() as RootState;

    // 🚀 额外引入一个 Loop 控制器，用于中止整个 Agent 循环
    const loopController = new AbortController();
    // Compose shared AbortError name detection with loop/thunk cancellation.
    const isTurnAborted = (error?: unknown) =>
        isAbortError(error) || loopController.signal.aborted || thunkApi.signal.aborted;
    const onAbort = () => loopController.abort();
    thunkApi.signal.addEventListener("abort", onAbort);
    let loopKey: string | null = null;
    let runtimeDialogKey: string | null = explicitDialogKey ?? null;
    let remoteTransientMessageId: string | null = null;
    let remoteTransientMessageFinalized = false;
    let modelRequestStarted = false;
    // Carries the abort outcome across the try/catch boundary into finally so
    // the queue-drain decision can distinguish "user stopped" (clear queue)
    // from "turn ended normally" (let the queue adapter drain follow-ups).
    let turnAborted = false;

    // 防止同一 dialog 的并发 streamAgentChatTurn：检查是否已有活跃 loop
    if (explicitDialogKey) {
        const dialogId = extractCustomId(explicitDialogKey);
        const existingLoopKey = `loop:${dialogId}`;
        const activeControllers = selectActiveControllers(
            getState() as RootState,
            explicitDialogKey,
        );
        if (activeControllers[existingLoopKey]) {
            console.warn(
                "[streamAgentChatTurn] Rejected concurrent turn for dialog",
                { dialogId, agentKey },
            );
            return rejectWithValue("Agent is already responding for this dialog");
        }
    }

    try {
        let totalTurnUsage: any = null;
        const agentRunUserInput = normalizeAgentRunUserInput(userInput);
        logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-entered", {
            agentKey,
            dialogKey: explicitDialogKey ?? null,
        });
        // 1. 解析 Agent 配置。优先级：调用方直接给的执行配置（auto 档位来自
        // 代码内置 profile，无需任何记录） > redux 缓存 > 读库。读库拿不到或
        // 拿到残缺记录时，回落到内置平台配置——四个档位 key 的 agent-pub-*
        // 记录按设计可以不存在，不能因此让整轮失败。
        const cachedAgentConfig = selectById(
            getState() as RootState,
            agentKey,
        );
        let rawAgentConfig: Agent | null = null;
        let agentConfigSource: string;

        if (isUsableAgentConfig(providedAgentConfig)) {
            rawAgentConfig = providedAgentConfig;
            agentConfigSource = "provided";
        } else if (isUsableAgentConfig(cachedAgentConfig)) {
            rawAgentConfig = cachedAgentConfig;
            agentConfigSource = "cache";
        } else {
            const builtinFallback = resolveBuiltinPlatformAgentRecord(
                agentKey,
            ) as Agent | null;
            try {
                const readConfig = await readAgentConfigForTurn(
                    dispatch,
                    agentKey,
                    quickChatPerfStartedAt,
                );
                if (isUsableAgentConfig(readConfig)) {
                    rawAgentConfig = readConfig;
                    agentConfigSource = "read";
                } else {
                    // 记录存在但缺 provider/model（历史残缺副本）：内置配置更可信。
                    rawAgentConfig = builtinFallback ?? readConfig ?? null;
                    agentConfigSource = builtinFallback
                        ? "builtin-unusable-record"
                        : "read";
                }
            } catch (error) {
                if (isTurnAborted(error) || !builtinFallback) throw error;
                console.warn(
                    "[streamAgentChatTurn] Agent record unavailable; using builtin platform config",
                    { agentKey, error: toErrorMessage(error) },
                );
                rawAgentConfig = builtinFallback;
                agentConfigSource = "builtin-read-failed";
            }
        }
        if (!rawAgentConfig) {
            return rejectWithValue(
                `Agent config not found for ID: ${agentKey}`,
            );
        }

        // quick-chat 自动模式模型层覆盖：分类路由落到通用档时，
        // 用收藏 agent 的 model 层替换档位 agent 的 model 层并合并技能引用。
        // 在读取配置后立刻应用，web / cli / desktop 路由共用同一份覆盖结果。
        if (runtimeOptions?.quickChatModelOverride) {
            rawAgentConfig = applyQuickChatModelOverride(
                rawAgentConfig,
                runtimeOptions.quickChatModelOverride,
            );
        }
        if (
            runtimeOptions?.quickChatReasoningEffort &&
            (rawAgentConfig.model === "deepseek-v4-flash" ||
                rawAgentConfig.model === "deepseek-v4-pro")
        ) {
            rawAgentConfig = {
                ...rawAgentConfig,
                reasoning_effort: runtimeOptions.quickChatReasoningEffort,
            };
        }

        // ── Live-audio-only guard ────────────────────────────────────────────
        if (isLiveAudioOnlyAgent(rawAgentConfig)) {
            return rejectWithValue(
                "此 Agent 仅支持实时语音模式，请使用语音面板进行对话。",
            );
        }

        const agentConfig = resolveWebAgentRuntimeToolSurface(
            rawAgentConfig,
            getState() as RootState,
        );
        logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-config-read", {
            agentKey,
            model: agentConfig.model,
            provider: agentConfig.provider,
            apiSource: agentConfig.apiSource,
            source: agentConfigSource,
        });

        const gptProCheck = shouldBlockForGptPro(
            agentConfig,
            selectIdentityUser(getState() as RootState)?.gptProAccess?.status,
        );
        if (gptProCheck.blocked) {
            return rejectWithValue(gptProCheck.message);
        }

        const configuredBoundMachineId = asTrimmedString(
            (agentConfig as any).runtimeBinding?.machineId,
        );
        const boundMachineId = resolveRemoteBoundMachineId(configuredBoundMachineId);

        // ── Remote runtime route ─────────────────────────────────────────────
        // runtimeBinding selects the bound machine. Without it, custom provider
        // requests stay on the normal OpenAI-compatible path, where
        // useServerProxy decides server proxy vs current-client direct fetch.
        if (agentConfig.apiSource === "cli" || (boundMachineId && !getIsDesktopApp())) {
            console.info("[streamAgentChatTurn] Triggered CLI/machine route. apiSource:", agentConfig.apiSource, "boundMachineId:", boundMachineId, "agentKey:", agentKey);
            const currentState = getState() as RootState;
            const w =
                typeof globalThis !== "undefined" && (globalThis as any).window
                    ? (globalThis as any).window
                    : null;
            if (w) w.__LOOP_STOP_REASON__ = null;

            const userText = extractAgentRunUserText(userInput);

            const prompt = buildCliPrompt(agentConfig.prompt, userText);

            // 生成消息 key
            const dialogConfig =
                selectDialogConfigByKey(currentState, explicitDialogKey) ??
                selectCurrentDialogConfig(currentState);
            if (!dialogConfig) {
                return rejectWithValue("Dialog config not found");
            }

            const dialogKey = explicitDialogKey || dialogConfig.dbKey;
            if (!dialogKey) {
                return rejectWithValue("当前对话不存在，无法发送消息。");
            }
            runtimeDialogKey = dialogKey;
            const dialogId = extractCustomId(dialogKey);
            loopKey = `loop:${dialogId}`;
            dispatch(addActiveController({ messageId: loopKey, controller: loopController, dialogKey }));

            const { key: msgKey, messageId } = createDialogMessageKeyAndId(dialogId);
            const cliMessageMetadata = buildMessageMetadata(agentConfig);
            if (boundMachineId) {
                const token = selectIdentityToken(currentState);
                const authHeader = token ? `Bearer ${token}` : "";
                const rawMessages = selectAllMsgs(currentState, dialogId);
                const visibleMessages = buildAgentViewMessages(
                    rawMessages as any,
                    agentConfig.dbKey,
                );
                const cleanedMessages = filterAndCleanMessages(visibleMessages);
                const currentServer = selectCurrentServer(currentState);
                remoteTransientMessageId = messageId;
                let accumulated = "";
                let totalTurnUsage: any = undefined;
                const buildMachineAssistantMessage = () => ({
                    id: messageId,
                    dbKey: msgKey,
                    role: "assistant" as const,
                    content: accumulated,
                    ...cliMessageMetadata,
                    userId: selectIdentityUserId(getState() as RootState),
                });

                // 服务器端 SSE 工具事件 → 前端 tool 卡片（与桌面 local runtime 分支同构）
                const remoteToolHandlers = createRemoteToolEventHandlers({
                    dialogId,
                    dispatch,
                    messageMetadata: cliMessageMetadata,
                });

                dispatch(messageStreaming({
                    id: messageId,
                    dialogId,
                    dbKey: msgKey,
                    content: "",
                    role: "assistant",
                    ...cliMessageMetadata,
                }));

                const rejectMachineStream = async (message: string) => {
                    if (accumulated.length > 0) {
                        await persistMessageWithFixedId(dispatch, buildMachineAssistantMessage());
                    } else {
                        dispatch(removeTransientMessage(messageId));
                    }
                    // best-effort 清理 tool 行：保留已完成的，移除空占位，避免僵尸 streaming 状态
                    await persistRemoteToolMessagesAndCleanup(
                        dispatch,
                        remoteToolHandlers.activeToolMessages,
                    ).catch(() => {});
                    setLoopStopReason("error");
                    remoteTransientMessageFinalized = true;
                    return rejectWithValue(message);
                };

                const machineResponse = await fetch(`${currentServer.replace(/\/+$/, "")}/api/agent/run`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "text/event-stream",
                        ...(authHeader ? { Authorization: authHeader } : {}),
                    },
                    body: JSON.stringify({
                        agentKey,
                        userInput: agentRunUserInput,
                        messages: cleanedMessages,
                        stream: true,
                        persistDialog: false,
                        clientDialogId: dialogId,
                        runtimeContext: {
                            surface: "web",
                            host: "browser",
                            runtime: "react",
                            entrypoint: "chat-dialog",
                            capabilities: ["streaming", "dialog-ui", "machine-bound-cli"],
                        },
                        ...((dialogConfig as any)?.spaceId ? { spaceId: (dialogConfig as any).spaceId } : {}),
                    }),
                    signal: loopController.signal,
                });

                if (!machineResponse.ok) {
                    return await rejectMachineStream(
                        await formatMachineAgentRunError(machineResponse),
                    );
                }

                const reader = machineResponse.body?.getReader();
                if (!reader) {
                    return await rejectMachineStream("无法读取电脑端 Agent 流式响应");
                }

                const decoder = new TextDecoder();
                const parseSSE = createSSEParser();
                const abortMachineStream = async () => {
                    if (w) w.__LOOP_STOP_REASON__ = "aborted";
                    if (accumulated.length <= 0) {
                        // 没有文本也要清理可能已建的 tool 行
                        await persistRemoteToolMessagesAndCleanup(
                            dispatch,
                            remoteToolHandlers.activeToolMessages,
                        ).catch(() => {});
                        return;
                    }
                    await persistMessageWithFixedId(dispatch, buildMachineAssistantMessage());
                    await persistRemoteToolMessagesAndCleanup(
                        dispatch,
                        remoteToolHandlers.activeToolMessages,
                    ).catch(() => {});
                };

                try {
                    const result = await consumeAgentRunStream({
                        reader,
                        decoder,
                        parseChunk: (raw) => parseSSE(raw),
                        isAborted: () =>
                            loopController.signal.aborted || thunkApi.signal.aborted,
                        signal: loopController.signal,
                        onAbort: abortMachineStream,
                        isDoneEvent: (payload) => payload?.type === "done",
                        onPayload: (payload) => {
                            if (payload.type === "error") {
                                return { reject: payload.message || "电脑端 Agent 执行失败" };
                            }
                            // 工具事件投影成 tool 卡片（assistant_tool_calls / tool_result）
                            remoteToolHandlers.handleToolPayload(payload);
                            if (payload.type === "text" && typeof payload.content === "string") {
                                accumulated += payload.content;
                                dispatch(messageStreaming({
                                    id: messageId,
                                    dialogId,
                                    dbKey: msgKey,
                                    content: accumulated,
                                    role: "assistant",
                                    ...cliMessageMetadata,
                                }));
                            }
                            if (payload.type === "done") {
                                totalTurnUsage = payload.usage;
                            }
                        },
                    });

                    if (result.outcome === "rejected") {
                        return await rejectMachineStream(result.message);
                    }
                    if (result.outcome === "aborted") {
                        // onAbort 已完成清理/持久化;返回 abort 标记而非 undefined,
                        // quick-chat 才能把「取消」和「启动失败」区分开(见外层 catch)。
                        return { aborted: true };
                    }
                    if (result.outcome === "streamEnded") {
                        if (!result.sawDone) {
                            // 连接被静默中断:没有收到完成信号,视为异常终止,
                            // 保留已累积内容并标记错误,而不是当成完整回复落库。
                            dispatch(finalizeTransientMessageOnError({
                                id: messageId,
                                error: "电脑端 Agent 流式响应被中断,未收到完成信号",
                            }));
                            await persistRemoteToolMessagesAndCleanup(
                                dispatch,
                                remoteToolHandlers.activeToolMessages,
                            ).catch(() => {});
                            remoteTransientMessageFinalized = true;
                            setLoopStopReason("error");
                            return rejectWithValue(
                                "电脑端 Agent 流式响应被中断,未收到完成信号",
                            );
                        }
                        await persistMessageWithFixedId(dispatch, buildMachineAssistantMessage());
                        await persistRemoteToolMessagesAndCleanup(
                            dispatch,
                            remoteToolHandlers.activeToolMessages,
                        );
                        remoteTransientMessageFinalized = true;
                    }
                } finally {
                    try {
                        await reader.cancel();
                    } catch {
                        // ignore
                    }
                    // 兜底：consumeAgentRunStream 抛非 abort/reject 异常时，确保
                    // 已 dispatch 的 tool 卡片不留下僵尸 isStreaming:true 状态。
                    // 正常路径已 clear，此处幂等空操作。
                    if (remoteToolHandlers.activeToolMessages.size > 0) {
                        await persistRemoteToolMessagesAndCleanup(
                            dispatch,
                            remoteToolHandlers.activeToolMessages,
                        ).catch(() => {});
                    }
                }

                return {
                    usage: totalTurnUsage ?? undefined,
                };
            }

            let cliSessionId = dialogConfig.cliSessionId ?? null;

            // 先创建一条空的流式消息（让用户立刻看到 loading 状态）
            dispatch(messageStreaming({
                id: messageId,
                dialogId,
                dbKey: msgKey,
                content: "",
                role: "assistant",
                ...cliMessageMetadata,
            }));
            remoteTransientMessageId = messageId;

            const ensureCliSession = async () => {
                if (cliSessionId) {
                    const existing = await getCliChatSession(
                        { getState },
                        { sessionId: cliSessionId },
                    ).catch(() => null);
                    if (existing?.ok && existing?.session?.sessionId) {
                        return cliSessionId;
                    }
                }

                const started = await startCliChatSession(
                    { getState },
                    {
                        cliProvider: agentConfig.cliProvider || "copilot",
                        model: agentConfig.model || undefined,
                        systemPrompt: agentConfig.prompt || undefined,
                        reasoningEffort:
                          agentConfig.reasoning_effort || agentConfig.reasoningEffort || undefined,
                        temperature: agentConfig.temperature,
                        topP: agentConfig.top_p,
                        frequencyPenalty: agentConfig.frequency_penalty,
                        presencePenalty: agentConfig.presence_penalty,
                        maxTokens: agentConfig.max_tokens,
                        enableThinking: agentConfig.enableThinking,
                        thinkingBudget: agentConfig.thinkingBudget,
                    },
                );

                const newSessionId =
                    typeof started?.sessionId === "string" ? started.sessionId : null;
                if (!newSessionId) {
                    throw new Error("无法创建 CLI session。");
                }

                cliSessionId = newSessionId;
                const patchResult = dispatch(
                    patch({
                        dbKey: dialogKey,
                        changes: {
                            cliSessionId: newSessionId,
                        },
                    })
                ) as any;
                try {
                    if (typeof patchResult?.unwrap === "function") {
                        await patchResult.unwrap();
                    } else {
                        await patchResult;
                    }
                } catch {
                    // Best effort only. Session still exists server-side even if dialog persistence fails.
                }
                return newSessionId;
            };

            const initialSessionId = await ensureCliSession();
            console.info("[streamAgentChatTurn] Calling CLI turn stream. Session ID:", initialSessionId);
            let resp = await createCliChatTurnStream(
                {
                    getState,
                },
                {
                    sessionId: initialSessionId,
                    prompt,
                    model: agentConfig.model || undefined,
                },
                loopController.signal,
            );

            if (!resp.ok && resp.status === 404) {
                console.warn("[streamAgentChatTurn] CLI Session 404. Re-creating session...");
                cliSessionId = null;
                const renewedSessionId = await ensureCliSession();
                console.info("[streamAgentChatTurn] Retrying CLI turn stream. Session ID:", renewedSessionId);
                resp = await createCliChatTurnStream(
                    {
                        getState,
                    },
                    {
                        sessionId: renewedSessionId,
                        prompt,
                        model: agentConfig.model || undefined,
                    },
                    loopController.signal,
                );
            }

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ error: resp.statusText }));
                console.error("[streamAgentChatTurn] Local CLI fetch failed. Status:", resp.status, "Error details:", err);
                dispatch(removeTransientMessage(messageId));
                setLoopStopReason("error");
                remoteTransientMessageFinalized = true;
                return rejectWithValue(err.error || "CLI 执行失败");
            }

            // 读取 SSE 流并逐步更新消息内容
            const reader = resp.body?.getReader();
            if (!reader) {
                dispatch(removeTransientMessage(messageId));
                setLoopStopReason("error");
                remoteTransientMessageFinalized = true;
                return rejectWithValue("无法读取流式响应");
            }

            let accumulated = "";
            let cliCapabilityWarnings: string[] = [];
            let cliTurnUsage: any = null;
            const decoder = new TextDecoder();
            const buildCliAssistantMessage = () => ({
                id: messageId,
                dbKey: msgKey,
                role: "assistant" as const,
                content: accumulated,
                ...cliMessageMetadata,
                userId: selectIdentityUserId(getState() as RootState),
            });
            const rejectCliStream = async (message: string) => {
                if (accumulated.length > 0) {
                    await persistMessageWithFixedId(dispatch, buildCliAssistantMessage());
                } else {
                    dispatch(removeTransientMessage(messageId));
                }
                setLoopStopReason("error");
                remoteTransientMessageFinalized = true;
                return rejectWithValue(message);
            };
            const abortCliStream = async () => {
                if (w) w.__LOOP_STOP_REASON__ = "aborted";
                if (accumulated.length <= 0) {
                    return;
                }
                await persistMessageWithFixedId(dispatch, buildCliAssistantMessage());
            };

            try {
                const result = await consumeAgentRunStream({
                    reader,
                    decoder,
                    parseChunk: (raw) => {
                        // 解析 SSE 格式 "data: {...}\n\n";逐行尝试解析,失败行忽略。
                        const parsed: any[] = [];
                        for (const line of raw.split("\n")) {
                            if (!line.startsWith("data: ")) continue;
                            try {
                                parsed.push(JSON.parse(line.slice(6)));
                            } catch {
                                // 忽略解析失败的行
                            }
                        }
                        return parsed;
                    },
                    isAborted: () =>
                        loopController.signal.aborted || thunkApi.signal.aborted,
                    signal: loopController.signal,
                    onAbort: abortCliStream,
                    isDoneEvent: (payload) => payload?.done === true,
                    onPayload: (payload) => {
                        if (payload.error) {
                            return { reject: payload.error };
                        }
                        if (payload.chunk) {
                            accumulated += payload.chunk;
                            dispatch(messageStreaming({
                                id: messageId,
                                dialogId,
                                dbKey: msgKey,
                                content: accumulated,
                                role: "assistant",
                                ...cliMessageMetadata,
                            }));
                        }
                        if (payload.done && Array.isArray(payload.warnings)) {
                            cliCapabilityWarnings = payload.warnings.filter(
                                (warning: unknown): warning is string =>
                                    typeof warning === "string" && warning.trim().length > 0
                            );
                        }
                        // CLI provider 子进程通常不返回 usage；少数 provider 未来可能报告。
                        // 读取并累计，streamEnded 后若无值则走字符估算。
                        if (payload.done && payload.usage) {
                            cliTurnUsage = updateTotalUsage(cliTurnUsage, payload.usage);
                        }
                    },
                });

                if (result.outcome === "rejected") {
                    return await rejectCliStream(result.message);
                }
                if (result.outcome === "aborted") {
                    // onAbort 已完成清理/持久化;返回 abort 标记而非 undefined,
                    // quick-chat 才能把「取消」和「启动失败」区分开(见外层 catch)。
                    return { aborted: true };
                }
                if (result.outcome === "streamEnded") {
                    if (!result.sawDone) {
                        // 连接被静默中断:未收到完成信号,视为异常终止,
                        // 保留已累积内容并标记错误,而不是当成完整回复落库。
                        dispatch(finalizeTransientMessageOnError({
                            id: messageId,
                            error: "CLI 流式响应被中断,未收到完成信号",
                        }));
                        remoteTransientMessageFinalized = true;
                        setLoopStopReason("error");
                        return rejectWithValue("CLI 流式响应被中断,未收到完成信号");
                    }

                    if (cliCapabilityWarnings.length > 0) {
                        accumulated = appendCliCapabilityWarnings(accumulated, cliCapabilityWarnings);
                        dispatch(messageStreaming({
                            id: messageId,
                            dialogId,
                            dbKey: msgKey,
                            content: accumulated,
                            role: "assistant",
                            ...cliMessageMetadata,
                        }));
                    }

                    // 持久化最终消息：用已有 ID，避免 prepareAndPersistMessage 重新生成 ID 导致重复
                    await persistMessageWithFixedId(dispatch, buildCliAssistantMessage());
                    remoteTransientMessageFinalized = true;

                    // 补 token 统计：CLI 子进程通常不返回 usage，走字符估算。
                    // 只有估算时才强制 apiSource="cli" → resolveBillable early-return false，
                    // 只写统计不扣费（含远程绑定机器的平台 agent 估算场景）。
                    // 如果 CLI 子进程返回了真实 usage（有非零 token），保留原 apiSource，
                    // 让平台 agent 的真实 usage 正常计费。
                    // 空/零 usage（如 {} 或全零）视为"没拿到真实 usage"，走估算。
                    // dialogKey 缺失时跳过（无归属对话）。
                    const cliUsageRaw = cliTurnUsage as any;
                    const hasRealUsage = !!cliUsageRaw &&
                        ((cliUsageRaw.prompt_tokens ?? cliUsageRaw.input_tokens ?? 0) +
                         (cliUsageRaw.completion_tokens ?? cliUsageRaw.output_tokens ?? 0) +
                         (cliUsageRaw.cache_creation_input_tokens ?? 0) +
                         (cliUsageRaw.cache_read_input_tokens ?? 0)) > 0;
                    const isCliEstimated = !hasRealUsage;
                    const cliUsage = hasRealUsage ? cliUsageRaw : estimateMissingUsage({ content: accumulated });
                    if (dialogKey) {
                        try {
                            await dispatch((updateTokens as any)({
                                dialogId,
                                dialogKey,
                                usage: cliUsage,
                                agentConfig: isCliEstimated
                                    ? { ...agentConfig, apiSource: "cli" }
                                    : agentConfig,
                            })).unwrap();
                        } catch (err) {
                            console.warn("[streamAgentChatTurn] CLI token stats dispatch failed", err);
                        }
                    }
                }
            } finally {
                try {
                    await reader.cancel();
                } catch {
                    // ignore
                }
            }

            return;
        }
        // ─────────────────────────────────────────────────────────────────────

        const currentDialog =
            selectDialogConfigByKey(state, explicitDialogKey) ??
            selectCurrentDialogConfig(state);
        const activeDialogKey = currentDialog?.dbKey;
        const dialogKey = explicitDialogKey || activeDialogKey;

        if (!dialogKey) {
            return rejectWithValue("当前对话不存在，无法发送消息。");
        }
        runtimeDialogKey = dialogKey;
        const dialogId = extractCustomId(dialogKey);
        logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-dialog-resolved", {
            dialogKey,
            dialogId,
        });

        if (shouldUseDesktopLocalRuntime(agentConfig)) {
            const desktopMessageMetadata = buildMessageMetadata(agentConfig);
            const w =
                typeof globalThis !== "undefined" && (globalThis as any).window
                    ? (globalThis as any).window
                    : null;
            loopKey = `loop:${dialogId}`;
            dispatch(addActiveController({ messageId: loopKey, controller: loopController, dialogKey }));

            let currentContent = "";
            // List of all assistant text messages created during this turn.
            // Each entry records the segment's finalized content + ids. The last
            // entry is the currently-streaming segment; when a tool call
            // interrupts the stream we finalize it (stop appending deltas) and
            // start a fresh segment so the new text lands *after* the tool card
            // in message-record order. ULID ids are monotonically increasing,
            // and the entity adapter sorts by `id` (`localeCompare`), so a
            // newly created assistant message id is always greater than the
            // preceding tool message id — preserving the true timeline.
            const assistantSegments: DesktopAssistantSegment[] = [];
            let assistantMessageKeys: { key: string; messageId: string } | null = null;
            let streamResult: any = null;
            let streamError: string | null = null;
            // 累计桌面 SSE 的 thinking 事件内容（reasoning_content），供
            // messageStreamEnd 持久化为 thinkContent（见 messageSlice）。
            // 兜底用 streamResult.reasoning_content（provider 在 SSE 流内累计）。
            let reasoningBuffer = "";
            const activeToolMessages = new Map<string, any>();
            const ensureAssistantMessageKeys = () => {
                if (!assistantMessageKeys) {
                    assistantMessageKeys = createDialogMessageKeyAndId(dialogId);
                    assistantSegments.push({
                        key: assistantMessageKeys.key,
                        messageId: assistantMessageKeys.messageId,
                        content: "",
                        finalized: false,
                        toolCallIds: [],
                    });
                    remoteTransientMessageId = assistantMessageKeys.messageId;
                }
                return assistantMessageKeys;
            };
            const streamDesktopAssistantText = (text: string) => {
                currentContent += text;
                const { key: msgKey, messageId } = ensureAssistantMessageKeys();
                const segment = assistantSegments[assistantSegments.length - 1];
                segment.content = currentContent;
                dispatch(messageStreaming({
                    id: messageId,
                    dialogId,
                    dbKey: msgKey,
                    content: currentContent,
                    role: "assistant",
                    isStreaming: true,
                    ...desktopMessageMetadata,
                }));
            };
            // When a tool call arrives, finalize the current assistant segment so the
            // tool card renders in its true position: the running segment stops accepting deltas,
            // and the next delta starts a brand-new assistant message (new id) whose
            // record-order position follows the tool message.
            const finalizeCurrentAssistantSegmentForTool = () => {
                const segment = assistantSegments[assistantSegments.length - 1];
                if (segment) {
                    segment.content = currentContent;
                    segment.finalized = true;
                }
                // Mark the just-streamed segment as no longer streaming so the UI
                // stops showing the spinner on it; drop the reference so the next
                // delta mints a new id. currentContent is reset for the next segment.
                // Only dispatch the finalize message when there is streamed text —
                // a tool-first turn produces an empty pre-tool segment that still
                // needs to exist (to carry tool_calls at persist time) but must not
                // be pushed to the store as a contentless bubble (isAssistantToolStub
                // can't filter it without tool_calls).
                if (assistantMessageKeys && currentContent.length > 0) {
                    dispatch(messageStreaming({
                        id: assistantMessageKeys.messageId,
                        dialogId,
                        dbKey: assistantMessageKeys.key,
                        content: currentContent,
                        role: "assistant",
                        isStreaming: false,
                        ...desktopMessageMetadata,
                    }));
                }
                assistantMessageKeys = null;
                currentContent = "";
            };

            try {
                const desktopAgentRef = agentConfig.dbKey || agentKey;
                // Request-scoped authoritative snapshot: webview IndexedDB is the
                // truth for logged-out local agents; host LevelDB must not be a
                // second copy. Credential material stays as credentialRef only.
                const eventStream = runDesktopAgentRuntimeTurnStream({
                    agentRef: desktopAgentRef,
                    input: userInput,
                    continueDialogId: dialogId,
                    dialogKey,
                    cwd: runtimeOptions?.cwd,
                    restrictShellToWorkspace: runtimeOptions?.restrictShellToWorkspace === true,
                    workspaceToolsHint: runtimeOptions?.workspaceToolsHint === true,
                    agentConfigSnapshot: agentConfig as Record<string, unknown>,
                    dialogMessages: selectAllMsgs(getState() as RootState, dialogId),
                    signal: loopController.signal,
                });

                for await (const event of eventStream) {
                    if (loopController.signal.aborted || thunkApi.signal.aborted) {
                        if (w) w.__LOOP_STOP_REASON__ = "aborted";
                        break;
                    }
                    if (event.type === "delta") {
                        streamDesktopAssistantText(event.text);
                    } else if (event.type === "thinking") {
                        // B1 已在 localLoop/service/handler 链路打通 onReasoningDelta
                        // → SSE {type:"thinking",content}。这里累计进 reasoningBuffer，
                        // 在 messageStreamEnd 时传给 messageSlice 落成 thinkContent。
                        if (typeof event.content === "string") {
                            reasoningBuffer += event.content;
                        }
                    } else if (event.type === "tool") {
                        const toolEvent = event.event;
                        const callId = toolEvent.toolCallId;
                        if (!callId) continue;

                        if (toolEvent.type === "tool-call") {
                            attachToolCallIdToSegment(assistantSegments, callId);
                            finalizeCurrentAssistantSegmentForTool();
                            const { key: dbKey, messageId: toolMsgId } = createDialogMessageKeyAndId(dialogId);
                            const toolMsg = {
                                id: toolMsgId,
                                dialogId,
                                dbKey,
                                role: "tool" as const,
                                content: "",
                                isStreaming: true,
                                toolName: toolEvent.toolName,
                                toolCallId: callId,
                                ...(toolEvent.argumentsPreview
                                    ? {
                                        toolPayload: {
                                            input: {
                                                command: toolEvent.argumentsPreview,
                                                cmd: toolEvent.argumentsPreview,
                                            },
                                        },
                                        metadata: {
                                            argumentsPreview: toolEvent.argumentsPreview,
                                        },
                                    }
                                    : {}),
                            };
                            activeToolMessages.set(callId, toolMsg);
                            dispatch(messageStreaming(toolMsg));
                        } else if (toolEvent.type === "tool-result" || toolEvent.type === "tool-error") {
                            const existing = activeToolMessages.get(callId);
                            if (existing) {
                                const isError = toolEvent.type === "tool-error";
                                const existingMeta = asRecordOrEmpty(existing.metadata);
                                const existingInput = isRecord(existing.toolPayload?.input)
                                    ? existing.toolPayload.input
                                    : {};
                                const mergedMeta: Record<string, unknown> = {
                                    ...existingMeta,
                                    ...toolEvent.metadata,
                                    ...(isError ? { error: true, message: toolEvent.message } : {}),
                                };
                                const toolResultMsg = {
                                    ...existing,
                                    isStreaming: false,
                                    content: projectDesktopToolUiContent({
                                        toolName: toolEvent.toolName || existing.toolName,
                                        content: toolEvent.content,
                                        summary: toolEvent.summary,
                                        message: toolEvent.message,
                                        metadata: mergedMeta,
                                        argumentsPreview:
                                            asOptionalTrimmedString(mergedMeta.argumentsPreview) ||
                                            asOptionalTrimmedString(existingInput.command) ||
                                            asOptionalTrimmedString(existingInput.cmd) ||
                                            undefined,
                                    }),
                                    metadata: mergedMeta,
                                };
                                activeToolMessages.set(callId, toolResultMsg);
                                dispatch(messageStreaming(toolResultMsg));
                            }
                        }
                    } else if (event.type === "done") {
                        streamResult = event.result;
                    } else if (event.type === "error") {
                        streamError = event.error;
                    }
                }
            } catch (err: any) {
                if (isAbortError(err) || loopController.signal.aborted || thunkApi.signal.aborted) {
                    if (w) w.__LOOP_STOP_REASON__ = "aborted";
                } else {
                    streamError = err?.message || "Local turn read stream error";
                }
            }

            // User stop: keep partial assistant/tool rows without treating abort as a hard error.
            if (
                loopController.signal.aborted ||
                thunkApi.signal.aborted ||
                (typeof streamError === "string" &&
                    /operation was aborted/i.test(streamError))
            ) {
                if (w) w.__LOOP_STOP_REASON__ = "aborted";
                // Keep the currently streaming segment content in the list for persist.
                // Snapshot with explicit annotation: assistantMessageKeys is reassigned
                // inside nested closures, which defeats TS control-flow narrowing here.
                const stopKeys = assistantMessageKeys as
                    | { key: string; messageId: string }
                    | null;
                if (stopKeys) {
                    const last = assistantSegments[assistantSegments.length - 1];
                    if (last && last.messageId === stopKeys.messageId) {
                        last.content = currentContent;
                    }
                }
                // Stop path: persist segments declaring tool_calls too, not
                // just text. `desktopTurnMessages` is unavailable here (the
                // stream broke before `done`, so `streamResult` is unset),
                // so we cannot reuse `resolveSegmentToolCalls`. Build minimal
                // tool_call objects from the known callIds + toolName (from
                // activeToolMessages) instead. content-empty but toolCallIds-
                // non-empty segments must NOT be removed — they own the
                // tool_call declarations, deleting them would orphan the
                // already-persisted tool rows and trigger empty replies next
                // turn. We also cannot reuse `selectPersistableFinalizedSegments`
                // because the last streaming segment is not yet `finalized`
                // here; mirror its `content || toolCallIds` semantics inline.
                // Only declare callIds whose tool row survives below (the
                // durableTools loop drops content-empty rows via
                // removeTransientMessage). Declaring a dropped row's id would
                // leave a dangling tool_call — the mirror of the orphan bug.
                const stopToolNameById = new Map<string, string>();
                for (const [callId, toolMsg] of activeToolMessages) {
                    if (!toolMessageWillPersist(toolMsg)) continue;
                    const toolName = (toolMsg as any)?.toolName;
                    stopToolNameById.set(
                        callId,
                        typeof toolName === "string" && toolName ? toolName : "tool",
                    );
                }
                for (const segment of assistantSegments) {
                    const hasContent = segment.content.trim().length > 0;
                    const hasToolCalls =
                        segment.toolCallIds && segment.toolCallIds.length > 0;
                    if (hasContent || hasToolCalls) {
                        const stopToolCalls = buildMinimalToolCallsFromIds(
                            segment.toolCallIds,
                            stopToolNameById
                        );
                        await persistMessageWithFixedId(dispatch, {
                            id: segment.messageId,
                            dbKey: segment.key,
                            role: "assistant",
                            content: segment.content,
                            ...(stopToolCalls.length > 0
                                ? { tool_calls: stopToolCalls }
                                : {}),
                            ...desktopMessageMetadata,
                            userId: selectIdentityUserId(getState() as RootState),
                        });
                    } else {
                        dispatch(removeTransientMessage(segment.messageId));
                    }
                }
                const durableTools: any[] = [];
                for (const toolMsg of activeToolMessages.values()) {
                    const content = (toolMsg as any)?.content;
                    const hasContent =
                        typeof content === "string"
                            ? content.trim().length > 0
                            : Array.isArray(content) && content.length > 0;
                    if (!hasContent) {
                        dispatch(removeTransientMessage((toolMsg as any).id));
                        continue;
                    }
                    const stopped = { ...toolMsg, isStreaming: false };
                    dispatch(messageStreaming(stopped));
                    durableTools.push(stopped);
                }
                await persistToolMessages(dispatch, durableTools, {
                    isStreaming: false,
                    soft: true,
                });
                remoteTransientMessageFinalized = true;
                // 用户取消:返回 abort 标记而非 undefined,quick-chat 才能把
                // 「取消」和「启动失败」区分开(见外层 catch)。
                return { aborted: true };
            }

            // On error, keep what the user already watched happen: finalize
            // non-empty transients (assistant text + executed tool messages)
            // with an error marker instead of wiping the whole trace down to a
            // single error badge. Empty transients are still removed.
            // Note: every assistant text segment created this turn must be
            // finalized — earlier segments were already detached from the
            // stream when their following tool call arrived, so they are still
            // flagged isStreaming unless we finalize them here.
            // Tool rows are also written to DB best-effort so a refresh still
            // shows the partial trajectory (not only assistant narrations).
            const finalizeDesktopTurnOnError = async (errorText: string) => {
                // Error path: persist segments declaring tool_calls too, not
                // just text. `desktopTurnMessages` is unavailable here (the
                // stream errored before `done`, so `streamResult` is unset),
                // so we cannot reuse `resolveSegmentToolCalls`. Build minimal
                // tool_call objects from the known callIds + toolName (from
                // activeToolMessages) instead. content-empty but toolCallIds-
                // non-empty segments must NOT go through
                // `finalizeTransientMessageOnError` alone — its reducer maps
                // empty content to `kind:"remove"`, deleting the owning
                // assistant and orphaning the already-persisted tool rows,
                // which triggers empty replies next turn. Mirror
                // `selectPersistableFinalizedSegments` `content || toolCallIds`
                // semantics inline (the last streaming segment is not yet
                // `finalized`, so we cannot call that helper directly).
                // Same durability filter as the stop path: a tool row that the
                // durableTools loop drops must not stay declared on the assistant.
                const errorToolNameById = new Map<string, string>();
                for (const [callId, toolMsg] of activeToolMessages) {
                    if (!toolMessageWillPersist(toolMsg)) continue;
                    const toolName = (toolMsg as any)?.toolName;
                    errorToolNameById.set(
                        callId,
                        typeof toolName === "string" && toolName ? toolName : "tool",
                    );
                }
                for (const segment of assistantSegments) {
                    const hasContent = segment.content.trim().length > 0;
                    const hasToolCalls =
                        segment.toolCallIds && segment.toolCallIds.length > 0;
                    if (hasContent || hasToolCalls) {
                        // Persist with fixed id + tool_calls so the owning
                        // assistant survives the error turn. Non-empty content
                        // also still gets the error marker via the reducer
                        // below for UI parity, but the DB row is authoritative.
                        const errorToolCalls = buildMinimalToolCallsFromIds(
                            segment.toolCallIds,
                            errorToolNameById
                        );
                        await persistMessageWithFixedId(dispatch, {
                            id: segment.messageId,
                            dbKey: segment.key,
                            role: "assistant",
                            content: segment.content,
                            ...(errorToolCalls.length > 0
                                ? { tool_calls: errorToolCalls }
                                : {}),
                            ...desktopMessageMetadata,
                            userId: selectIdentityUserId(getState() as RootState),
                        });
                        if (hasContent) {
                            dispatch(finalizeTransientMessageOnError({
                                id: segment.messageId,
                                error: errorText,
                            }));
                        }
                    } else {
                        dispatch(finalizeTransientMessageOnError({
                            id: segment.messageId,
                            error: errorText,
                        }));
                    }
                }
                // Tools that already ran successfully must NOT get error stamps —
                // only stop streaming so the trajectory stays truthful on refresh.
                const durableTools: any[] = [];
                for (const toolMsg of activeToolMessages.values()) {
                    const content = (toolMsg as any)?.content;
                    const hasContent = typeof content === "string"
                        ? content.trim().length > 0
                        : Array.isArray(content) && content.length > 0;
                    if (!hasContent) {
                        dispatch(removeTransientMessage((toolMsg as any).id));
                        continue;
                    }
                    const stopped = { ...toolMsg, isStreaming: false };
                    dispatch(messageStreaming(stopped));
                    durableTools.push(stopped);
                }
                // soft: turn already failed — write best-effort so a refresh
                // still shows tool trajectory without rejecting the outer path.
                await persistToolMessages(dispatch, durableTools, {
                    isStreaming: false,
                    soft: true,
                });
                remoteTransientMessageFinalized = true;
                setLoopStopReason("error");
            };

            if (streamError) {
                await finalizeDesktopTurnOnError(streamError);
                return rejectWithValue(streamError);
            }

            if (!streamResult) {
                const message = "Local turn stream closed unexpectedly without result";
                await finalizeDesktopTurnOnError(message);
                return rejectWithValue(message);
            }

            const desktopTurnMessages = (streamResult as any).turnMessages || [];
            // Done-only path: no tool events fired during the stream, so no segment
            // recorded any callId. tool messages are projected below from
            // turnMessages, but without a preceding assistant declaring those
            // tool_call_ids the persisted history holds orphan tool rows — the next
            // provider round sees tool messages with no owning assistant and replies
            // with empty messages. Fix: mint the assistant segment (its ULID must be
            // earlier than the tool messages projected right after) and attach the
            // tool_call ids from turnMessages, then finalize so the final "Done."
            // text starts a fresh segment. Mirrors the tool-event path's
            // [assistant(tool_calls) → tool×N → assistant(text)] ordering.
            const hasSegmentWithCallIds = assistantSegments.some(
                (s) => s.toolCallIds.length > 0,
            );
            if (!hasSegmentWithCallIds) {
                const doneOnlyAssistantCalls = desktopTurnMessages
                    .filter(
                        (m: any) =>
                            m?.role === "assistant" &&
                            Array.isArray(m.tool_calls) &&
                            m.tool_calls.length > 0,
                    )
                    .flatMap((m: any) => m.tool_calls.map((tc: any) => tc?.id))
                    .filter((id: any): id is string => typeof id === "string");
                if (doneOnlyAssistantCalls.length > 0) {
                    ensureAssistantMessageKeys();
                    for (const callId of doneOnlyAssistantCalls) {
                        attachToolCallIdToSegment(assistantSegments, callId);
                    }
                    // Conditional finalize to avoid duplicate/empty bubbles in mixed
                    // streams (delta text already streamed but no tool event fired).
                    // - currentContent.length === 0 (pure done-only, no streamed text):
                    //   finalize so the trailing "Done." text starts a fresh segment.
                    // - currentContent.length > 0 (mixed stream): do NOT finalize. The
                    //   call ids are already attached to the current streaming segment;
                    //   it is persisted later by messageStreamEnd together with
                    //   lastSegmentToolCalls. Finalizing here would clear
                    //   assistantMessageKeys/currentContent, causing
                    //   ensureAssistantMessageKeys() to mint a second segment S2 whose
                    //   content comes from streamResult.content (full content) → S1 and
                    //   S2 duplicate, or an empty trailing bubble when that is empty.
                    if (currentContent.length === 0) {
                        finalizeCurrentAssistantSegmentForTool();
                    }
                }
            }
            if (activeToolMessages.size === 0) {
                for (const toolMessage of buildDesktopRuntimeToolMessagesForUi({
                    dialogId,
                    turnMessages: desktopTurnMessages,
                })) {
                    dispatch(messageStreaming(toolMessage));
                    activeToolMessages.set(
                        asTrimmedString(toolMessage.toolCallId) || toolMessage.id,
                        toolMessage,
                    );
                }
            }

            // Shared web+desktop durable write path (same as toolThunks).
            // Without this, desktop only messageStreaming → refresh drops tools.
            // soft: tools already executed; a write failure (or a single row
            // missing dbKey) must not reject the whole successful turn.
            await persistToolMessages(
                dispatch,
                activeToolMessages.values(),
                { isStreaming: false, soft: true },
            );

            // Persist earlier assistant text segments that were finalized when
            // their following tool call interrupted the stream. These are no
            // longer streaming (marked isStreaming:false above) but were never
            // written to the database, so persist them now with fixed ids so
            // history reload preserves the [A, tool, B] ordering. The final
            // segment is persisted below via messageStreamEnd.
            const earlierFinalizedSegments = selectPersistableFinalizedSegments(assistantSegments);
            for (const segment of earlierFinalizedSegments) {
                const segmentToolCalls = resolveSegmentToolCalls(
                    segment.toolCallIds,
                    desktopTurnMessages,
                );
                dispatch(write({
                    data: {
                        id: segment.messageId,
                        dbKey: segment.key,
                        dialogId,
                        content: segment.content,
                        role: "assistant",
                        isStreaming: false,
                        type: DataType.MSG,
                        ...(segmentToolCalls.length > 0 ? { tool_calls: segmentToolCalls } : {}),
                        ...desktopMessageMetadata,
                    },
                    customKey: segment.key,
                }));
            }

            const { key: msgKey, messageId } = ensureAssistantMessageKeys();
            // 流内已执行工具的 provider（如 Cursor）：streaming 已通过 onTextDelta
            // 分段渲染了所有文本，每个工具到达时 finalize 了前一段。done 事件不需要
            // 用 result.content 覆盖——用 currentContent（最后一段的增量累积，可能
            // 为空如果最后是工具调用）。常规 provider 用 result.content。
            const lastSegmentContent = hasInlineExecutedToolCalls(streamResult)
                ? (currentContent || "")
                : (streamResult.content || currentContent || "");
            const segment = assistantSegments[assistantSegments.length - 1];
            segment.content = lastSegmentContent;
            dispatch(messageStreaming({
                id: messageId,
                dialogId,
                dbKey: msgKey,
                content: lastSegmentContent,
                role: "assistant",
                isStreaming: false,
                ...desktopMessageMetadata,
            }));

            const lastSegmentToolCalls = segment
                ? resolveSegmentToolCalls(segment.toolCallIds, desktopTurnMessages)
                : [];

            await dispatch(messageStreamEnd({
                finalContentBuffer: [
                    {
                        type: "text",
                        text: lastSegmentContent,
                    },
                ],
                totalUsage: streamResult.usage ?? undefined,
                billingUsageRecords: streamResult.usageRecords,
                messageId,
                msgKey,
                agentConfig,
                dialogId,
                dialogKey,
                // 优先用本 turn 累计的 thinking SSE；为空时兜底 streamResult.reasoning_content
                // （provider 在 SSE 流内累计返回的 reasoning_content）。
                reasoningBuffer: reasoningBuffer || (typeof streamResult?.reasoning_content === "string" ? streamResult.reasoning_content : ""),
                toolCalls: lastSegmentToolCalls,
                // 把 provider 报告的 finish_reason 透传给 messageStreamEnd，
                // 由 assembleFinalAssistantMessage 决定是否写进最终 Message。
                finishReason: streamResult.finish_reason ?? undefined,
                messageMetadata: desktopMessageMetadata,
            })).unwrap();
            remoteTransientMessageFinalized = true;
            return {
                usage: streamResult.usage ?? undefined,
            };
        }

        const userInputText = extractAgentRunUserText(userInput);

        const explicitServerBase =
            asOptionalTrimmedString(args.serverBase) ?? null;
        const currentServer = selectCurrentServer(state);
        const normalizedRequestedServerBase =
            explicitServerBase && normalizeServerOrigin(explicitServerBase);
        const normalizedCurrentServer = normalizeServerOrigin(
            currentServer,
        );
        const canProxyToExplicitServerBase =
            !Array.isArray(userInput) &&
            !runtimeOptions?.extraTools?.length &&
            !runtimeOptions?.editingTarget &&
            !runtimeOptions?.imageConfigOverride;
        if (explicitServerBase && canProxyToExplicitServerBase) {
            if (
                normalizedRequestedServerBase &&
                normalizedCurrentServer &&
                normalizedRequestedServerBase === normalizedCurrentServer
            ) {
                // Same server as the current workspace; keep the UI-managed
                // chat/tool loop and let /api/chat hydrate redacted provider
                // credentials server-side when needed.
            } else {
                const token = selectIdentityToken(state);
                const authHeader = token ? `Bearer ${token}` : "";
                const rawMessages = selectAllMsgs(state, dialogId);
                const visibleMessages = buildAgentViewMessages(
                    rawMessages as any,
                    agentConfig.dbKey,
                );
                const cleanedMessages = filterAndCleanMessages(visibleMessages);
                const { key: msgKey, messageId } = createDialogMessageKeyAndId(dialogId);
                remoteTransientMessageId = messageId;
                const remoteMessageMetadata = buildMessageMetadata(agentConfig);
                let accumulated = "";
                let totalTurnUsage: any = undefined;
                const buildRemoteAssistantMessage = () => ({
                    id: messageId,
                    dbKey: msgKey,
                    role: "assistant" as const,
                    content: accumulated,
                    ...remoteMessageMetadata,
                    userId: selectIdentityUserId(getState() as RootState),
                });

                // 服务器端 SSE 工具事件 → 前端 tool 卡片（与桌面 local runtime 分支同构）
                const remoteToolHandlers = createRemoteToolEventHandlers({
                    dialogId,
                    dispatch,
                    messageMetadata: remoteMessageMetadata,
                });

                loopKey = `loop:${dialogId}`;
                dispatch(addActiveController({ messageId: loopKey, controller: loopController, dialogKey }));
                dispatch(messageStreaming({
                    id: messageId,
                    dialogId,
                    dbKey: msgKey,
                    content: "",
                    role: "assistant",
                    ...remoteMessageMetadata,
                }));

                const rejectRemoteStream = async (message: string) => {
                    if (accumulated.length > 0) {
                        await persistMessageWithFixedId(dispatch, buildRemoteAssistantMessage());
                    } else {
                        dispatch(removeTransientMessage(messageId));
                    }
                    // best-effort 清理 tool 行：保留已完成的，移除空占位，避免僵尸 streaming 状态
                    await persistRemoteToolMessagesAndCleanup(
                        dispatch,
                        remoteToolHandlers.activeToolMessages,
                    ).catch(() => {});
                    setLoopStopReason("error");
                    remoteTransientMessageFinalized = true;
                    return rejectWithValue(message);
                };

                const remoteRequestBody = JSON.stringify({
                    agentKey,
                    userInput: agentRunUserInput,
                    messages: cleanedMessages,
                    stream: true,
                    persistDialog: false,
                    clientDialogId: dialogId,
                    runtimeContext: {
                        surface: "web",
                        host: "browser",
                        runtime: "react",
                        entrypoint: "chat-dialog",
                        capabilities: ["streaming", "dialog-ui", "tool-cards"],
                    },
                    ...(runtimeOptions?.quickChatReasoningEffort
                        ? {
                              runtimeOptions: {
                                  quickChatReasoningEffort:
                                      runtimeOptions.quickChatReasoningEffort,
                              },
                          }
                        : {}),
                    ...(currentDialog?.spaceId ? { spaceId: currentDialog.spaceId } : {}),
                });
                const remoteRunUrl = `${explicitServerBase.replace(/\/+$/, "")}/api/agent/run`;
                const remoteResponse = await performServerProxyFetchWithRetry({
                    execute: () => fetch(remoteRunUrl, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Accept: "text/event-stream",
                            ...(authHeader ? { Authorization: authHeader } : {}),
                        },
                        body: remoteRequestBody,
                        signal: loopController.signal,
                    }),
                    signal: loopController.signal,
                    logPrefix: "[streamAgentChatTurn.remoteRun]",
                });

                if (!remoteResponse.ok) {
                    const errorText = await remoteResponse.text();
                    return await rejectRemoteStream(
                        errorText || `Remote agent run failed (${remoteResponse.status})`,
                    );
                }

                const reader = remoteResponse.body?.getReader();
                if (!reader) {
                    return await rejectRemoteStream("无法读取远端流式响应");
                }

                const decoder = new TextDecoder();
                const parseSSE = createSSEParser();
                const abortRemoteStream = async () => {
                    if (accumulated.length <= 0) {
                        await persistRemoteToolMessagesAndCleanup(
                            dispatch,
                            remoteToolHandlers.activeToolMessages,
                        ).catch(() => {});
                        return;
                    }
                    await persistMessageWithFixedId(dispatch, buildRemoteAssistantMessage());
                    await persistRemoteToolMessagesAndCleanup(
                        dispatch,
                        remoteToolHandlers.activeToolMessages,
                    ).catch(() => {});
                };

                try {
                    const result = await consumeAgentRunStream({
                        reader,
                        decoder,
                        parseChunk: (raw) => parseSSE(raw),
                        isAborted: () =>
                            loopController.signal.aborted || thunkApi.signal.aborted,
                        signal: loopController.signal,
                        onAbort: abortRemoteStream,
                        isDoneEvent: (payload) => payload?.type === "done",
                        onPayload: async (payload) => {
                            if (payload.type === "error") {
                                return { reject: payload.message || "远端 Agent 执行失败" };
                            }
                            if (payload.type === "agent_handoff") {
                                await patchDialogThreadMetadata(
                                    dispatch,
                                    dialogKey,
                                    payload.threadMetadata,
                                );
                                await patchDialogActiveAgent(
                                    dispatch,
                                    dialogKey,
                                    payload.agentKey,
                                );
                            }
                            // 工具事件投影成 tool 卡片（assistant_tool_calls / tool_result）
                            remoteToolHandlers.handleToolPayload(payload);
                            if (payload.type === "text" && typeof payload.content === "string") {
                                accumulated += payload.content;
                                dispatch(messageStreaming({
                                    id: messageId,
                                    dialogId,
                                    dbKey: msgKey,
                                    content: accumulated,
                                    role: "assistant",
                                    ...remoteMessageMetadata,
                                }));
                            }
                            if (payload.type === "done") {
                                totalTurnUsage = payload.usage;
                            }
                        },
                    });

                    if (result.outcome === "rejected") {
                        return await rejectRemoteStream(result.message);
                    }
                    if (result.outcome === "aborted") {
                        // onAbort 已完成清理/持久化;返回 abort 标记而非 undefined,
                        // quick-chat 才能把「取消」和「启动失败」区分开(见外层 catch)。
                        return { aborted: true };
                    }
                    if (result.outcome === "streamEnded") {
                        if (!result.sawDone) {
                            // 连接被静默中断:没有收到完成信号,视为异常终止,
                            // 保留已累积内容并标记错误,而不是当成完整回复落库。
                            dispatch(finalizeTransientMessageOnError({
                                id: messageId,
                                error: "远端 Agent 流式响应被中断,未收到完成信号",
                            }));
                            await persistRemoteToolMessagesAndCleanup(
                                dispatch,
                                remoteToolHandlers.activeToolMessages,
                            ).catch(() => {});
                            remoteTransientMessageFinalized = true;
                            setLoopStopReason("error");
                            return rejectWithValue(
                                "远端 Agent 流式响应被中断,未收到完成信号",
                            );
                        }
                        await persistMessageWithFixedId(dispatch, buildRemoteAssistantMessage());
                        await persistRemoteToolMessagesAndCleanup(
                            dispatch,
                            remoteToolHandlers.activeToolMessages,
                        );
                        remoteTransientMessageFinalized = true;
                    }
                } finally {
                    try {
                        await reader.cancel();
                    } catch {
                        // ignore
                    }
                    // 兜底：consumeAgentRunStream 抛非 abort/reject 异常时，确保
                    // 已 dispatch 的 tool 卡片不留下僵尸 isStreaming:true 状态。
                    // 正常路径已 clear，此处幂等空操作。
                    if (remoteToolHandlers.activeToolMessages.size > 0) {
                        await persistRemoteToolMessagesAndCleanup(
                            dispatch,
                            remoteToolHandlers.activeToolMessages,
                        ).catch(() => {});
                    }
                }

                return {
                    usage: totalTurnUsage ?? undefined,
                };
            }
        }

        // Extract Mentions from userInput if it's potentially Slate content
        let extractedMentions: CategorizedMentions | undefined;
        if (Array.isArray(userInput)) {
            // Basic check if it looks like Slate nodes (has children) or just assume safe to traverse
            // extractCategorizedMentions handles traversal safely.
            extractedMentions = extractCategorizedMentions(userInput as any);
        }

        const mentionedTools = extractedMentions?.tools ?? [];

        // 2. 解析引用：包含 tools 的页面自动升级为 instruction
        const {
            references: normalizedReferences,
            contentByKey: referenceContentCache,
            referencedTools: referenceTools,
            recommendedSkillTools: referenceRecommendedSkillTools,
            recommendedSkillHints: referenceRecommendedSkillHints,
            skillPromptPatches: referenceSkillPromptPatches,
        } = await resolveReferenceAssets(
            mergeReferences(agentConfig.references, (selectDialogConfigByKey(getState(), explicitDialogKey) ?? selectCurrentDialogConfig(getState()))?.extraReferences),
            dispatch
        );
        logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-references-resolved", {
            referenceCount: normalizedReferences?.length ?? 0,
            referencedToolCount: referenceTools?.length ?? 0,
        });

        const agentConfigWithReferences: import("./buildSystemPrompt").AgentRuntimeConfig = {
            ...agentConfig,
            references: normalizedReferences,
            referencedTools: referenceTools,
            recommendedSkillTools: referenceRecommendedSkillTools,
            recommendedSkillHints: referenceRecommendedSkillHints,
            skillPromptPatches: referenceSkillPromptPatches,
        };

        // --- [新增] 提取本次 Handler 启动前的稳定历史消息 ID 集合 ---
        const initialRawMsgs = selectAllMsgs(state, dialogId);
        const initialHistoryIds = new Set(initialRawMsgs.map((m: any) => m.id));

        const keySets = await getFullChatContextKeys(
            state,
            dispatch,
            agentConfigWithReferences,
            userInput,
            currentDialog ?? undefined,
        );
        const finalKeys = deduplicateContextKeys(keySets);
        const allContextKeys = new Set<string>([
            ...finalKeys.botInstructionsContext,
            ...finalKeys.currentInputContext,
            ...finalKeys.historyContext,
            ...finalKeys.botKnowledgeContext,
        ]);

        // 4. 上下文页面里提取 tools 并缓存内容
        const {
            tools: contextTools,
            contentByKey: contextContentCache,
            recommendedSkillTools: contextRecommendedSkillTools = [],
            recommendedSkillHints: contextRecommendedSkillHints = [],
            skillPromptPatches: contextSkillPromptPatches = [],
        } = await resolveToolsFromKeys(
            Array.from(allContextKeys),
            dispatch,
            referenceContentCache,
        );

        const mergedContentCache = new Map<string, any>([
            ...referenceContentCache,
            ...contextContentCache,
        ]);

        // 4. 合并工具 (Base + Default + Context + Mentioned + Runtime) + 图片配置
        const agentConfigWithTools = mergeAgentToolsWithRuntime(
            {
                ...agentConfigWithReferences,
                recommendedSkillTools: [
                    ...(((agentConfigWithReferences as any).recommendedSkillTools ?? []) as string[]),
                    ...contextRecommendedSkillTools,
                ],
                recommendedSkillHints: [
                    ...(((agentConfigWithReferences as any).recommendedSkillHints ?? []) as string[]),
                    ...contextRecommendedSkillHints,
                ],
                skillPromptPatches: [
                    ...(((agentConfigWithReferences as any).skillPromptPatches ?? []) as string[]),
                    ...contextSkillPromptPatches,
                ],
            },
            contextTools,
            mentionedTools,
            runtimeOptions,
            state,
        );
        const agentConfigForCall = applyImageConfigRuntimeOverride(
            agentConfigWithTools,
            runtimeOptions,
        );

        const effectiveAgentConfig = agentConfigForCall;
        const initialImageGenerationState = resolveImageGenerationStreamingState(
            effectiveAgentConfig,
        );
        const streamingMessageMetadata = {
            ...buildMessageMetadata(agentConfigForCall),
            ...(initialImageGenerationState
                ? { imageGenerationState: initialImageGenerationState }
                : {}),
        };

        const isRespModel =
            resolveClientWire(
                resolveAgentCallPlan(agentConfigForCall as any, {}),
            ) === "responses";

        // 🔹 Response-style 模型：与 completions 一样走完整 Agent Loop
        if (isRespModel) {
            const maxExecutionTime = selectMaxExecutionTime(state);
            const MAX_TIME_MS = maxExecutionTime > 0 ? maxExecutionTime : 240_000;
            const startTime = Date.now();

            const staticContexts = await buildStaticContextsWithToolsPrewarm(
                state,
                dispatch,
                agentConfigForCall,
                currentDialog ?? undefined,
                mergedContentCache,
            );
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-static-context-ready", {
                model: agentConfigForCall.model,
                responseApi: true,
            });
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-post-static-entered", {
                responseApi: true,
            });

            let appendTempUserInput = true;
            let currentParentMessageId = parentMessageId ?? undefined;
            const storedResponsesState = currentDialog?.responsesState;
            let responsesState = selectResponsesConversationState(
                storedResponsesState,
                agentConfigForCall,
            );
            if (storedResponsesState != null && !responsesState) {
                dispatch(
                    patch({
                        dbKey: dialogKey,
                        changes: { responsesState: null },
                    }),
                );
            }

            const w = typeof globalThis !== "undefined" && (globalThis as any).window ? (globalThis as any).window : null;
            if (w) w.__LOOP_STOP_REASON__ = null;

            loopKey = `loop:${dialogId}`;
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-active-controller-adding", {
                responseApi: true,
            });
            dispatch(addActiveController({ messageId: loopKey, controller: loopController, dialogKey }));
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-active-controller-added", {
                responseApi: true,
            });

            for (;;) {
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-loop-entered", {
                    responseApi: true,
                });
                const requestParentMessageId = currentParentMessageId;
                if (loopController.signal.aborted || thunkApi.signal.aborted) {
                    logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-loop-aborted-before-context", {
                        loopControllerAborted: loopController.signal.aborted,
                        thunkSignalAborted: thunkApi.signal.aborted,
                        responseApi: true,
                    });
                    if (w) w.__LOOP_STOP_REASON__ = "aborted";
                    return { aborted: true };
                }

                const loopState = getState() as RootState;
                const now = Date.now();
                if (now - startTime > MAX_TIME_MS) {
                    logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-loop-timeout-before-context", {
                        maxTimeMs: MAX_TIME_MS,
                        elapsedMs: now - startTime,
                        responseApi: true,
                    });
                    if (w) w.__LOOP_STOP_REASON__ = "timeout";
                    break;
                }

                const accessError = validateAccessAndBalance(
                    agentConfigForCall,
                    loopState,
                );
                if (accessError) {
                    const accessErrorReason = classifyQuickChatAccessError(accessError);
                    logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-access-error-before-context", {
                        hasAccessError: true,
                        reason: accessErrorReason,
                        responseApi: true,
                    });
                    if (quickChatPerfStartedAt && runtimeDialogKey && !modelRequestStarted) {
                        logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-access-error-finalized", {
                            reason: accessErrorReason,
                            responseApi: true,
                        });
                        await finalizeQuickChatAgentTurnFailure(
                            dispatch,
                            runtimeDialogKey,
                            agentKey,
                            new Error(accessError),
                        );
                    }
                    setLoopStopReason("error");
                    return rejectWithValue(accessError);
                }

                const willSkipDynamicContext = canUseQuickChatEmptyDynamicContexts(
                    quickChatPerfStartedAt,
                    userInput,
                    runtimeOptions,
                    currentDialog,
                    agentConfigForCall,
                );
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-dynamic-context-decision", {
                    hasRuntimeOptions: !!runtimeOptions,
                    isSimpleTextInput: isSimpleTextInput(userInput),
                    referenceKeyCount: currentDialog?.referenceKeys?.length ?? 0,
                    willSkipDynamicContext,
                    responseApi: true,
                });

                const dynamicContexts = willSkipDynamicContext
                    ? (logQuickChatPerfStage(
                        quickChatPerfStartedAt,
                        "stream-agent-dynamic-context-skipped",
                        {
                            reason: "simple-quick-chat-first-turn",
                            responseApi: true,
                        },
                    ), EMPTY_DYNAMIC_CONTEXTS)
                    : await buildDynamicContextsForTurn(
                        loopState,
                        dispatch,
                        agentConfigForCall,
                        userInput,
                        runtimeOptions,
                        mergedContentCache,
                        dialogKey,
                        quickChatPerfStartedAt,
                    );
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-dynamic-context-ready", {
                    responseApi: true,
                });
                const contexts = mergeContexts(staticContexts, dynamicContexts);

                const rawMessages = selectAllMsgs(loopState, dialogId);
                let visibleMessages = buildAgentViewMessages(
                    rawMessages as any,
                    agentConfigForCall.dbKey,
                );

                if (
                    appendTempUserInput &&
                    hasAgentRunUserInputContent(agentRunUserInput) &&
                    !isLastMessageMatchingUserInput(visibleMessages, agentRunUserInput)
                ) {
                    visibleMessages = [
                        ...visibleMessages,
                        {
                            id: `__tmp_user_${Date.now()}`,
                            dbKey: "",
                            role: "user",
                            content: agentRunUserInput,
                            thinkContent: "",
                            cybotKey: agentConfigForCall.dbKey,
                            isStreaming: false,
                        } as any,
                    ];
                }

                const cleanedMessages = filterAndCleanMessages(visibleMessages);
                const ctxWindow =
                    getModelContextWindow(agentConfigForCall.model) || 128000;
                const summaryTokenCount = contexts.dialogSummary
                    ? estimateTokenCount(contexts.dialogSummary)
                    : 0;
                const processedMessages = trimMessagesWithSummary(
                    compressOldToolResults(cleanedMessages),
                    ctxWindow,
                    summaryTokenCount,
                );

                let firstDynamicIdx = processedMessages.findIndex(
                    (m) => m.id && !initialHistoryIds.has(m.id),
                );
                if (firstDynamicIdx === -1) firstDynamicIdx = processedMessages.length;

                const stableMessages = processedMessages.slice(0, firstDynamicIdx);
                const dynamicMessages = processedMessages.slice(firstDynamicIdx);

                if (appendTempUserInput) {
                    const rejectReason = shouldRejectImageInputForAgent(
                        agentConfigForCall as any,
                        processedMessages,
                    );
                    if (rejectReason) {
                        setLoopStopReason("error");
                        return rejectWithValue(rejectReason);
                    }
                }

                const bodyData = generateRequestBody({
                    agentConfig: effectiveAgentConfig,
                    messages: dynamicMessages as any,
                    stableMessages: stableMessages as any,
                    userInput: userInputText,
                    contexts,
                    responsesState,
                });
                const fallbackBodyData = responsesState
                    ? generateRequestBody({
                        agentConfig: effectiveAgentConfig,
                        messages: dynamicMessages as any,
                        stableMessages: stableMessages as any,
                        userInput: userInputText,
                        contexts,
                        responsesState: null,
                    })
                    : undefined;
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-model-request-starting", {
                    responseApi: true,
                    dynamicMessageCount: dynamicMessages.length,
                    stableMessageCount: stableMessages.length,
                });
                modelRequestStarted = true;

                const meta: CompletionMeta = await sendOpenAIResponseRequest({
                    bodyData,
                    agentConfig: agentConfigForCall,
                    thunkApi,
                    dialogKey,
                    parentMessageId: currentParentMessageId,
                    messageMetadata: streamingMessageMetadata,
                    quickChatPerfStartedAt,
                    fallbackBodyData,
                });
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-model-request-finished", {
                    responseApi: true,
                    hasToolCalls: meta.hasToolCalls,
                    hasHandedOff: meta.hasHandedOff,
                    hasPendingInteraction: meta.hasPendingInteraction,
                });

                appendTempUserInput = false;
                currentParentMessageId = undefined;
                if (meta.responseId) {
                    responsesState = updateResponsesConversationState(
                        agentConfigForCall,
                        meta.responseId,
                    );
                    if (responsesState) {
                        dispatch(
                            patch({
                                dbKey: dialogKey,
                                changes: { responsesState },
                            }),
                        );
                    } else if (meta.responsesStateFallback) {
                        dispatch(
                            patch({
                                dbKey: dialogKey,
                                changes: { responsesState: null },
                            }),
                        );
                    }
                } else if (meta.responsesStateFallback) {
                    responsesState = null;
                    dispatch(
                        patch({
                            dbKey: dialogKey,
                            changes: { responsesState: null },
                        }),
                    );
                }
                totalTurnUsage = updateTotalUsage(totalTurnUsage, meta.usage);

                if (meta.hasHandedOff) {
                    if (!requestParentMessageId && meta.messageId) {
                        dispatch(removeTransientMessage(meta.messageId));
                    }
                    if (w) w.__LOOP_STOP_REASON__ = "handoff";
                    break;
                }

                if (meta.hasPendingInteraction) {
                    if (w) w.__LOOP_STOP_REASON__ = "pending";
                    break;
                }

                const afterTurnState = getState() as RootState;
                const queuedMessages = selectPendingUserInputQueue(afterTurnState, dialogKey);
                if (queuedMessages.length > 0) {
                    const queuedText = queuedMessages[0];

                    const currentDialogConfig =
                        selectDialogConfigByKey(afterTurnState, dialogKey) ??
                        selectCurrentDialogConfig(afterTurnState);
                    if (!currentDialogConfig) {
                        dispatch(clearPendingUserInputQueue({ dialogKey }));
                        break;
                    }
                    await dispatch(
                        prepareAndPersistUserMessage({
                            userInput: queuedText,
                            dialogConfig: currentDialogConfig,
                        })
                    ).unwrap();
                    dispatch(dequeueUserInput({ dialogKey }));
                    continue;
                }

                if (!meta.hasToolCalls) {
                    if (w) w.__LOOP_STOP_REASON__ = "done";
                    break;
                }
            }

            return {
                usage: totalTurnUsage ?? undefined,
            };
        }

        // 🔹 Completions-style 模型：Agent Loop
        const maxExecutionTime = selectMaxExecutionTime(state);

        const MAX_TIME_MS = maxExecutionTime > 0 ? maxExecutionTime : 240_000;
        const startTime = Date.now();

        // 🚀 优化：在 Loop 外构建静态上下文（只执行一次）
        // 静态上下文包含：botInstructions、botKnowledge、spaceContext、userGlobalPrompt
        // 这些内容在 Loop 期间是稳定的，不需要每轮重新构建
        // 同时预热 prepareTools 缓存，避免首 token 前再付 schema 翻译/克隆成本
        const staticContexts = await buildStaticContextsWithToolsPrewarm(
            state,
            dispatch,
            agentConfigForCall,
            currentDialog ?? undefined,
            mergedContentCache,
        );
        logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-static-context-ready", {
            model: agentConfigForCall.model,
            responseApi: false,
        });
        logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-post-static-entered", {
            responseApi: false,
        });

        let appendTempUserInput = true;
        let currentParentMessageId = parentMessageId ?? undefined;

        const w = typeof globalThis !== "undefined" && (globalThis as any).window ? (globalThis as any).window : null;
        if (w) w.__LOOP_STOP_REASON__ = null;

        if (!isRespModel) {
            loopKey = `loop:${dialogId}`;
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-active-controller-adding", {
                responseApi: false,
            });
            dispatch(addActiveController({ messageId: loopKey, controller: loopController, dialogKey }));
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-active-controller-added", {
                responseApi: false,
            });
        }

        for (;;) {
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-loop-entered", {
                responseApi: false,
            });
            const requestParentMessageId = currentParentMessageId;
            // 每轮开始前检查是否已中止
            if (loopController.signal.aborted || thunkApi.signal.aborted) {
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-loop-aborted-before-context", {
                    loopControllerAborted: loopController.signal.aborted,
                    thunkSignalAborted: thunkApi.signal.aborted,
                    responseApi: false,
                });
                if (w) w.__LOOP_STOP_REASON__ = "aborted";
                return { aborted: true };
            }

            const loopState = getState() as RootState;
            const now = Date.now();
            if (now - startTime > MAX_TIME_MS) {
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-loop-timeout-before-context", {
                    maxTimeMs: MAX_TIME_MS,
                    elapsedMs: now - startTime,
                    responseApi: false,
                });
                if (w) w.__LOOP_STOP_REASON__ = "timeout";
                break;
            }

            // 每轮检查权限 & 余额
            const accessError = validateAccessAndBalance(
                agentConfigForCall,
                loopState,
            );
            if (accessError) {
                const accessErrorReason = classifyQuickChatAccessError(accessError);
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-access-error-before-context", {
                    hasAccessError: true,
                    reason: accessErrorReason,
                    responseApi: false,
                });
                if (quickChatPerfStartedAt && runtimeDialogKey && !modelRequestStarted) {
                    logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-access-error-finalized", {
                        reason: accessErrorReason,
                        responseApi: false,
                    });
                    await finalizeQuickChatAgentTurnFailure(
                        dispatch,
                        runtimeDialogKey,
                        agentKey,
                        new Error(accessError),
                    );
                }
                setLoopStopReason("error");
                return rejectWithValue(accessError);
            }

            const willSkipDynamicContext = canUseQuickChatEmptyDynamicContexts(
                quickChatPerfStartedAt,
                userInput,
                runtimeOptions,
                currentDialog,
                agentConfigForCall,
            );
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-dynamic-context-decision", {
                hasRuntimeOptions: !!runtimeOptions,
                isSimpleTextInput: isSimpleTextInput(userInput),
                referenceKeyCount: currentDialog?.referenceKeys?.length ?? 0,
                willSkipDynamicContext,
                responseApi: false,
            });

            // 🚀 优化：每轮只构建动态上下文（currentInput、history、editingContext、dialogSummary）
            const dynamicContexts = willSkipDynamicContext
                ? (logQuickChatPerfStage(
                    quickChatPerfStartedAt,
                    "stream-agent-dynamic-context-skipped",
                    {
                        reason: "simple-quick-chat-first-turn",
                        responseApi: false,
                    },
                ), EMPTY_DYNAMIC_CONTEXTS)
                : await buildDynamicContextsForTurn(
                    loopState,
                    dispatch,
                    agentConfigForCall,
                    userInput,
                    runtimeOptions,
                    mergedContentCache,
                    dialogKey,
                    quickChatPerfStartedAt,
                );
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-dynamic-context-ready", {
                responseApi: false,
            });

            // 合并静态和动态上下文
            const contexts = mergeContexts(staticContexts, dynamicContexts);

            const rawMessages = selectAllMsgs(loopState, dialogId);
            let visibleMessages = buildAgentViewMessages(
                rawMessages as any,
                agentConfigForCall.dbKey,
            );

            if (
                appendTempUserInput &&
                hasAgentRunUserInputContent(agentRunUserInput) &&
                !isLastMessageMatchingUserInput(visibleMessages, agentRunUserInput)
            ) {
                visibleMessages = [
                    ...visibleMessages,
                    {
                        id: `__tmp_user_${Date.now()}`,
                        dbKey: "",
                        role: "user",
                        content: agentRunUserInput,
                        thinkContent: "",
                        cybotKey: agentConfigForCall.dbKey,
                        isStreaming: false,
                    } as any,
                ];
            }

            const cleanedMessages = filterAndCleanMessages(visibleMessages);
            const ctxWindow =
                getModelContextWindow(agentConfigForCall.model) || 128000;
            const summaryTokenCount = contexts.dialogSummary
                ? estimateTokenCount(contexts.dialogSummary)
                : 0;
            const processedMessages = trimMessagesWithSummary(
                compressOldToolResults(cleanedMessages),
                ctxWindow,
                summaryTokenCount,
            );

            // --- [优化 P1] 使用 findIndex + slice 确保顺序和无 ID 稳定消息的保留 ---
            let firstDynamicIdx = processedMessages.findIndex(
                (m) => m.id && !initialHistoryIds.has(m.id),
            );
            if (firstDynamicIdx === -1) firstDynamicIdx = processedMessages.length;

            const stableMessages = processedMessages.slice(0, firstDynamicIdx);
            const dynamicMessages = processedMessages.slice(firstDynamicIdx);

            if (appendTempUserInput) {
                const rejectReason = shouldRejectImageInputForAgent(
                    agentConfigForCall as any,
                    processedMessages,
                );
                if (rejectReason) {
                    setLoopStopReason("error");
                    return rejectWithValue(rejectReason);
                }
            }

            const bodyData = generateRequestBody({
                agentConfig: effectiveAgentConfig,
                messages: dynamicMessages as any,
                stableMessages: stableMessages as any,
                userInput: userInputText,
                contexts,
            });
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-model-request-starting", {
                responseApi: false,
                dynamicMessageCount: dynamicMessages.length,
                stableMessageCount: stableMessages.length,
            });
            modelRequestStarted = true;

            const disableToolsForThisRequest =
                shouldDisableQuickChatToolsForDirectAnswer(
                    quickChatPerfStartedAt,
                    userInput,
                    runtimeOptions,
                    currentDialog,
                );
            if (disableToolsForThisRequest) {
                logQuickChatPerfStage(
                    quickChatPerfStartedAt,
                    "stream-agent-tools-disabled-for-direct-answer",
                    {
                        responseApi: false,
                        toolCount: Array.isArray(agentConfigForCall.tools)
                            ? agentConfigForCall.tools.length
                            : 0,
                    },
                );
            }

            const meta: CompletionMeta = await sendOpenAICompletionsRequest({
                bodyData,
                agentConfig: agentConfigForCall,
                thunkApi,
                dialogKey,
                parentMessageId: currentParentMessageId,
                messageMetadata: streamingMessageMetadata,
                disableToolsForThisRequest,
                quickChatPerfStartedAt,
            });
            logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-model-request-finished", {
                responseApi: false,
                hasToolCalls: meta.hasToolCalls,
                hasHandedOff: meta.hasHandedOff,
                hasPendingInteraction: meta.hasPendingInteraction,
            });

            appendTempUserInput = false;
            currentParentMessageId = undefined;
            totalTurnUsage = updateTotalUsage(totalTurnUsage, meta.usage);

            // handoff（例如 runStreamingAgent）：当前 Agent 停止，后续由子 Agent 自动续跑
            if (meta.hasHandedOff) {
                if (!requestParentMessageId && meta.messageId) {
                    dispatch(removeTransientMessage(meta.messageId));
                }
                if (w) w.__LOOP_STOP_REASON__ = "handoff";
                break;
            }

            if (meta.hasPendingInteraction) {
                if (w) w.__LOOP_STOP_REASON__ = "pending";
                break;
            }

            // 检查是否有用户在 loop 期间发送的排队消息
            const afterTurnState = getState() as RootState;
            const queuedMessages = selectPendingUserInputQueue(afterTurnState, dialogKey);
            if (queuedMessages.length > 0) {
                const queuedText = queuedMessages[0];

                const currentDialogConfig =
                    selectDialogConfigByKey(afterTurnState, dialogKey) ??
                    selectCurrentDialogConfig(afterTurnState);
                if (!currentDialogConfig) {
                    // 对话已切换/销毁，无法持久化；清空队列并终止 loop，避免死循环重试
                    dispatch(clearPendingUserInputQueue({ dialogKey }));
                    break;
                }
                await dispatch(
                    prepareAndPersistUserMessage({
                        userInput: queuedText,
                        dialogConfig: currentDialogConfig,
                    })
                ).unwrap();
                // 持久化成功后再出队，避免 persist 失败时丢消息
                dispatch(dequeueUserInput({ dialogKey }));
                // 用户消息已持久化到 DB，下一轮 selectAllMsgs 会自动包含它
                // 不设置 appendTempUserInput，直接继续下一轮
                continue;
            }

            if (!meta.hasToolCalls) {
                if (w) w.__LOOP_STOP_REASON__ = "done";
                break;
            }

            // 否则：存在 tool_calls 且没有 handoff / pending，基于新的 history 继续下一轮
        }

        return {
            usage: totalTurnUsage ?? undefined,
        };
    } catch (error: any) {
        if (isTurnAborted(error)) {
            turnAborted = true;
            if (remoteTransientMessageId && !remoteTransientMessageFinalized) {
                dispatch(removeTransientMessage(remoteTransientMessageId));
                remoteTransientMessageFinalized = true;
            }
            const w =
                typeof globalThis !== "undefined" && (globalThis as any).window
                    ? (globalThis as any).window
                    : null;
            if (w) w.__LOOP_STOP_REASON__ = "aborted";
            // 返回 abort 标记而不是 undefined:quick-chat 的 handleSendMessageAction
            // 把 undefined 当「启动失败」写错误文案,abort(含竞态取消)不是失败,
            // 必须能被区分(见 handleSendMessageAction 的 startup-failure 分支)。
            return { aborted: true };
        }
        console.error(
            `Error in streamAgentChatTurn for [${agentKey}]:`,
            error,
        );
        if (remoteTransientMessageId && !remoteTransientMessageFinalized) {
            // Keep partial streamed content visible with an error marker;
            // only empty transients get removed.
            dispatch(finalizeTransientMessageOnError({
                id: remoteTransientMessageId,
                error: toErrorMessage(error),
            }));
            remoteTransientMessageFinalized = true;
            setLoopStopReason("error");
        }
        if (
            quickChatPerfStartedAt &&
            runtimeDialogKey &&
            !modelRequestStarted &&
            !remoteTransientMessageId
        ) {
            await finalizeQuickChatAgentTurnFailure(
                dispatch,
                runtimeDialogKey,
                agentKey,
                error,
            );
        } else if (!isTurnAborted(error)) {
            setLoopStopReason("error");
        }

        return rejectWithValue(
            error?.message ||
            "An unexpected error occurred in streamAgentChatTurn.",
        );
    } finally {
        if (loopKey && runtimeDialogKey) {
            dispatch(removeActiveController({ messageId: loopKey, dialogKey: runtimeDialogKey }));
        } else if (loopKey) {
            dispatch(removeActiveController(loopKey));
        }
        // Queue lifecycle on turn end:
        //   - aborted: the user stopped the turn → abandon queued follow-ups.
        //   - otherwise: do NOT clear the queue here. The chat queue adapter
        //     (chatQueueReduxAdapter) is responsible for draining queued
        //     follow-ups after a clean turn end, or preserving them on
        //     failure. Clearing here used to drop every message the user
        //     queued while the agent was replying the moment the reply
        //     finished — which defeated the whole "queue while busy" feature.
        if (turnAborted) {
            dispatch(clearPendingUserInputQueue(runtimeDialogKey ? { dialogKey: runtimeDialogKey } : undefined));
        }
        // Run-overlay turn-end broadcast removed: the live run dock + background
        // run-completion wake channel already surface run progress; agents can
        // still query the full run set on demand via controlAgentRun(list).
        // Notify the cross-platform queue core that this turn ended. The
        // adapter (if registered in the store's thunk extra) will emit a
        // drain-ready event when the queue is non-empty and the turn ended
        // cleanly, and dispatch a continuation send. Stores without an adapter
        // (e.g. tests) simply ignore this no-op thunk.
        if (runtimeDialogKey) {
            dispatch(runChatQueueTurnEnd({
                dialogKey: runtimeDialogKey,
                ok: !turnAborted,
                aborted: turnAborted,
            }) as any);
        }
        thunkApi.signal.removeEventListener("abort", onAbort);
    }
};
