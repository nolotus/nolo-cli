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
import {
    resolveAgentCallPlan,
    resolveClientWire,
} from "../../agent-runtime/agentCallPlan";

import {
    sendOpenAICompletionsRequest,
    type CompletionMeta,
} from "../chat/sendOpenAICompletionsRequest";
import { sendOpenAIResponseRequest } from "../chat/sendOpenAIResponseRequest";

import type { AgentRuntimeOptions } from "./types";
import { buildAgentViewMessages } from "./cleanAgentMessages";
import { extractCategorizedMentions, type CategorizedMentions } from "../../create/editor/utils/slateUtils";
import { mergeReferences, resolveReferenceAssets, resolveToolsFromKeys } from "./referenceUtils";
import { estimateTokenCount } from "../context/tokenUtils";
import {
    applyImageConfigRuntimeOverride,
    buildStaticContexts,
    compressOldToolResults,
    buildDynamicContexts,
    mergeContexts,
    hasImageInMessages,
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
import { createSSEParser } from "../chat/parseMultilineSSE";
import { performServerProxyFetchWithRetry } from "../chat/serverProxyRetry";
import { normalizeServerOrigin } from "./serverOrigin";
import { getIsDesktopApp } from "../../app/utils/env";
import { runDesktopAgentRuntimeTurnStream } from "../../app/utils/desktopAgentRuntimeTurnClient";
import { resolveRuntimeToolSurfaceForAgent } from "../../agent-runtime/runtimeToolSurface";
import { prepareTools } from "../tools/prepareTools";

const buildMessageMetadata = (
    agentConfig: Agent,
) => {
    const rawName = asTrimmedString(agentConfig?.name);
    return {
        agentKey: agentConfig.dbKey,
        cybotKey: agentConfig.dbKey,
        ...(rawName ? { agentName: rawName } : {}),
    };
};



const buildDesktopRuntimeToolMessagesForUi = ({
    dialogId,
    turnMessages,
}: {
    dialogId: string;
    turnMessages?: any[];
}) => {
    if (!Array.isArray(turnMessages) || turnMessages.length === 0) return [];

    const toolNamesByCallId = new Map<string, string>();
    const activityByCallId = new Map<string, any>();
    const projected: any[] = [];

    for (const message of turnMessages) {
        if (Array.isArray(message?.tool_calls)) {
            for (const call of message.tool_calls) {
                const callId = asTrimmedString(call?.id);
                const toolName = asTrimmedString(call?.function?.name);
                if (callId && toolName) toolNamesByCallId.set(callId, toolName);

                // Extract _activity from tool call arguments for UI projection
                if (callId) {
                    try {
                        const args =
                            typeof call?.function?.arguments === "string"
                                ? JSON.parse(call.function.arguments)
                                : call?.function?.arguments;
                        const rawActivity = isRecord(args) ? args._activity : undefined;
                        const activity = isRecord(rawActivity)
                            ? (rawActivity as Record<string, unknown>)
                            : undefined;
                        const legacyTitle =
                            typeof activity?.title === "string" && activity.title.trim();
                        const action = activity?.action;
                        const actionTitle =
                            isRecord(action) &&
                            typeof action.title === "string" &&
                            action.title.trim();
                        const plan = activity?.plan;
                        const hasPlan =
                            isRecord(plan) &&
                            Array.isArray(plan.phases) &&
                            plan.phases.some((phase) => {
                                if (!isRecord(phase)) return false;
                                return typeof phase.title === "string" && !!phase.title.trim();
                            });
                        if (activity && (legacyTitle || actionTitle || hasPlan)) {
                            activityByCallId.set(callId, args._activity);
                        }
                    } catch {
                        // Ignore malformed tool call arguments
                    }
                }
            }
            continue;
        }

        if (message?.role !== "tool") continue;
        const toolCallId = asTrimmedString(message.tool_call_id);
        const metadata = asRecordOrEmpty(message.tool_result_metadata);
        const metadataToolName = asTrimmedString(metadata.toolName);
        const toolName =
            metadataToolName ||
            (toolCallId ? toolNamesByCallId.get(toolCallId) : "") ||
            "tool";
        const { key: dbKey, messageId } = createDialogMessageKeyAndId(dialogId);

        // Resolve activity: prefer tool result metadata.activity, fall back to tool call _activity
        const resultActivity =
            metadata.activity && typeof metadata.activity === "object"
                ? metadata.activity
                : undefined;
        const callActivity = toolCallId
            ? activityByCallId.get(toolCallId)
            : undefined;
        const activity = resultActivity || callActivity;

        // Merge activity into metadata so UI readers (ToolMessageGroup /
        // buildActivityTimeline) that look at message.metadata.activity see it.
        const mergedMetadata = activity
            ? { ...metadata, activity }
            : metadata;

        projected.push({
            id: messageId,
            dialogId,
            dbKey,
            role: "tool",
            content: projectDesktopToolUiContent({
                toolName,
                content: typeof message.content === "string" ? message.content : "",
                metadata: mergedMetadata,
            }),
            isStreaming: false,
            toolName,
            ...(toolCallId ? { toolCallId } : {}),
            ...(Object.keys(mergedMetadata).length ? { metadata: mergedMetadata } : {}),
        });
    }

    return projected;
};

const extractDesktopRuntimeToolCallsForUi = (turnMessages?: any[]) => {
    if (!Array.isArray(turnMessages) || turnMessages.length === 0) return [];
    return turnMessages.flatMap((message) =>
        Array.isArray(message?.tool_calls) ? message.tool_calls : []
    );
};

const shouldUseDesktopLocalRuntime = (
    agentConfig: Partial<Agent> | null | undefined,
) => {
    if (!getIsDesktopApp()) return false;
    return agentConfig?.apiSource !== "cli";
};

const readCurrentDesktopMachineId = () => {
    const fromProcess =
        typeof process !== "undefined"
            ? (process.env?.NOLO_CURRENT_MACHINE_ID || process.env?.NOLO_MACHINE_ID || "").trim()
            : "";
    if (fromProcess) return fromProcess;
    const w =
        typeof globalThis !== "undefined" && (globalThis as any).window
            ? (globalThis as any).window
            : null;
    const fromWindow =
        asTrimmedString(w?.__NOLO_CURRENT_MACHINE_ID__) ||
        asTrimmedString(w?.__NOLO_MACHINE_ID__);
    return fromWindow;
};

const resolveRemoteBoundMachineId = (machineId: string) => {
    if (!machineId || !getIsDesktopApp()) return machineId;
    const currentMachineId = readCurrentDesktopMachineId();
    return currentMachineId && currentMachineId === machineId ? "" : machineId;
};

const resolveWebAgentRuntimeToolSurface = (
    agentConfig: Agent,
    state: RootState,
): Agent => {
    const toolSurface = resolveRuntimeToolSurfaceForAgent({
        explicitToolNames: Array.isArray((agentConfig as any).tools)
            ? (agentConfig as any).tools
            : [],
        currentUserId: selectIdentityUserId(state),
        agentOwnerId: typeof (agentConfig as any).userId === "string"
            ? (agentConfig as any).userId
            : null,
        agentKey: (agentConfig as any).dbKey ?? (agentConfig as any).agentKey,
        isPublic: (agentConfig as any).isPublic === true,
        sharingLevel: typeof (agentConfig as any).sharingLevel === "string"
            ? (agentConfig as any).sharingLevel
            : null,
        runtimeHost: "web",
    });
    return {
        ...agentConfig,
        tools: toolSurface.finalToolNames,
        runtimeToolSurface: toolSurface,
    } as Agent;
};

const formatMachineAgentRunError = async (response: Response): Promise<string> => {
    const errorText = await response.text();
    let payload: any = null;
    try {
        payload = errorText ? JSON.parse(errorText) : null;
    } catch {
        payload = null;
    }

    const reason = typeof payload?.reason === "string" ? payload.reason : "";
    if (response.status === 409) {
        if (reason === "bound_machine_unavailable") {
            return "绑定的电脑不在线。请确认这台电脑已开机并重新运行连接命令。";
        }
        if (reason === "bound_machine_owner_mismatch") {
            return "这台电脑是在线的，但当前账号和 Agent 绑定账号不一致。请重新绑定 Agent，或在绑定账号下重新连接这台电脑。";
        }
        if (reason === "connector_offline") {
            return "电脑在线，但连接器未连接。请在这台电脑上重新运行连接命令后再试。";
        }
        if (reason === "missing_capability") {
            return "这台电脑没有对应的 CLI 能力。请安装对应 CLI，或把 Agent 绑定到另一台电脑。";
        }
    }

    const message =
        asOptionalTrimmedString(payload?.message) ??
        asOptionalTrimmedString(payload?.error) ??
        errorText.trim();
    return message || `Machine agent run failed (${response.status})`;
};

const normalizeThreadMetadataPatch = (value: unknown) => {
    if (!isRecord(value)) return null;
    const record = value;
    const changes: Record<string, string> = {};
    const threadKind = asOptionalTrimmedString(record.threadKind);
    if (threadKind) {
        changes.threadKind = threadKind;
    }
    const presentationIntent = asOptionalTrimmedString(record.presentationIntent);
    if (presentationIntent) {
        changes.presentationIntent = presentationIntent;
    }
    return Object.keys(changes).length > 0 ? changes : null;
};

const patchDialogThreadMetadata = async (
    dispatch: any,
    dialogKey: string,
    metadata: unknown,
) => {
    const changes = normalizeThreadMetadataPatch(metadata);
    if (!changes) return;
    await dispatch(
        patch({
            dbKey: dialogKey,
            changes,
        }),
    ).unwrap?.();
};

const patchDialogActiveAgent = async (
    dispatch: any,
    dialogKey: string,
    agentKey: unknown,
) => {
    if (typeof agentKey !== "string" || !agentKey.trim()) return;
    await dispatch(
        patch({
            dbKey: dialogKey,
            changes: {
                primaryAgentKey: agentKey.trim(),
            },
        }),
    ).unwrap?.();
};

/** streamAgentChatTurn 参数（聊天轮次专用） */
export interface StreamAgentChatTurnArgs {
    agentKey: string;
    userInput: string | any[];
    serverBase?: string;
    dialogKey?: string; // 可选。显式指定目标对话，不传则使用当前活跃对话。
    isStreaming?: boolean;
    parentMessageId?: string;
    runtimeOptions?: AgentRuntimeOptions;
    quickChatPerfStartedAt?: number;
}

const QUICK_CHAT_AGENT_CONFIG_READ_TIMEOUT_MS = 10_000;
const QUICK_CHAT_DYNAMIC_CONTEXT_TIMEOUT_MS = 5_000;
const EMPTY_DYNAMIC_CONTEXTS = {
    currentInputContext: null,
    historyContext: "",
    editingContext: null,
    appWorkingMemory: null,
    memoryOverlay: null,
    dialogSummary: null,
    proactiveSummary: null,
    referenceKeys: [],
};

function appendCliCapabilityWarnings(content: string, warnings: string[]): string {
    if (!warnings.length) return content;
    const warningBlock = `\n\n[CLI 能力提示]\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
    return `${content}${warningBlock}`;
}

/**
 * 共享的 reader 循环消费器:把 machine-bound / CLI / remote 三处几乎一样的
 * "read chunk → 解析 → 处理 payload → 检查 abort" 循环收敛到一处。
 *
 * 关键修复点:当 `reader.read()` 返回 `done:true` 时,只有真正收到过完成信号
 * (done 事件) 才算"正常结束";否则视为连接被静默中断(网络抖动 / keep-alive
 * 超时 / 系统休眠唤醒等),由调用方走异常终止路径,而不是把已累积的截断内容
 * 当成完整回复落库。
 *
 * - `onPayload` 负责副作用(累积文本、更新 usage、派发 streaming 等),
 *   返回 `{ reject: message }` 表示这一条 payload 要求走拒绝路径,
 *   返回 `{ abort: true }` 表示要中止(等价于在循环中检测到 abort)。
 * - `isDoneEvent` 判断某条 payload 是否是"完成信号",用于设置 `sawDone`。
 *   只要曾经出现过一次 done 事件,reader 自然结束时就算正常完成。
 *
 * 重要:abort 检测必须在判断 `done:true` **之前**做(而不是只在 payload 循环里查),
 * 否则用户主动取消发送时,可能因为流恰好在这个时间点自然结束(reader.read() 返回
 * done:true)而被误判成"连接异常截断"而不是正常的用户取消。
 */
type AgentRunStreamConsumeOutcome =
    | { outcome: "aborted" }
    | { outcome: "rejected"; message: string }
    | { outcome: "streamEnded"; sawDone: boolean };

interface AgentRunStreamHandlers {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    decoder: TextDecoder;
    /** 解码后的原始 chunk → 一组 payload(machine/remote 用 parseSSE,CLI 用手工行解析)。 */
    parseChunk: (raw: string) => any[];
    /** 处理单条 payload 的副作用;返回值用于控制流。可以是 async(允许 await 副作用)。 */
    onPayload: (
        payload: any,
    ) =>
        | void
        | { reject?: string; abort?: true }
        | Promise<void | { reject?: string; abort?: true }>;
    /** 判断 payload 是否是"完成信号",用于区分正常结束 vs 截断。 */
    isDoneEvent: (payload: any) => boolean;
    /** 是否已被中止(loopController / thunkApi signal)。 */
    isAborted: () => boolean;
    /**
     * Optional AbortSignal used to wake a blocked `reader.read()`.
     * Desktop webviews may not reject the body reader when fetch aborts after
     * headers — racing the signal cancels the reader immediately on stop.
     */
    signal?: AbortSignal;
    /** 中止时要执行的清理(如持久化已累积内容)。 */
    onAbort: () => Promise<void>;
}

async function readAgentRunStreamChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal | undefined,
    isAborted: () => boolean,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
    if (isAborted() || signal?.aborted) {
        void reader.cancel().catch(() => {});
        throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (!signal) {
        return reader.read();
    }

    let settled = false;
    return new Promise((resolve, reject) => {
        const finish = (cb: () => void) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            cb();
        };
        const onAbort = () => {
            void reader.cancel().catch(() => {});
            finish(() =>
                reject(new DOMException("The operation was aborted.", "AbortError")),
            );
        };
        signal.addEventListener("abort", onAbort);
        reader.read().then(
            (result) => finish(() => resolve(result)),
            (err) => finish(() => reject(err)),
        );
    });
}

async function consumeAgentRunStream(
    handlers: AgentRunStreamHandlers,
): Promise<AgentRunStreamConsumeOutcome> {
    const {
        reader,
        decoder,
        parseChunk,
        onPayload,
        isDoneEvent,
        isAborted,
        signal,
        onAbort,
    } = handlers;
    let sawDone = false;

    try {
        while (true) {
            let done: boolean;
            let value: Uint8Array | undefined;
            try {
                ({ done, value } = await readAgentRunStreamChunk(
                    reader,
                    signal,
                    isAborted,
                ));
            } catch (error) {
                if (isAbortError(error) || isAborted() || signal?.aborted) {
                    await onAbort();
                    return { outcome: "aborted" };
                }
                throw error;
            }
            // abort 检测必须在 done 判断之前:用户主动取消时,流可能恰好在此刻自然结束,
            // 此时应当走"用户取消"分支,而不是被误判为"连接异常截断"。
            if (isAborted() || signal?.aborted) {
                await onAbort();
                return { outcome: "aborted" };
            }
            if (done) {
                return { outcome: "streamEnded", sawDone };
            }

            const payloads = parseChunk(
                decoder.decode(value as Uint8Array, { stream: true }),
            );
            for (const payload of payloads) {
                if (isAborted() || signal?.aborted) {
                    await onAbort();
                    return { outcome: "aborted" };
                }
                const directive = await onPayload(payload);
                if (directive?.reject !== undefined) {
                    return { outcome: "rejected", message: directive.reject };
                }
                if (directive?.abort) {
                    await onAbort();
                    return { outcome: "aborted" };
                }
                if (isDoneEvent(payload)) {
                    sawDone = true;
                }
            }
        }
    } catch (error) {
        if (isAbortError(error) || isAborted() || signal?.aborted) {
            await onAbort();
            return { outcome: "aborted" };
        }
        throw error;
    }
}

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

const readAgentConfigForTurn = async (
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
                        {
                            agentKey,
                            timeoutMs: QUICK_CHAT_AGENT_CONFIG_READ_TIMEOUT_MS,
                        },
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

const buildDynamicContextsForTurn = async (
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
                    {
                        agentKey: agentConfig.dbKey,
                        dialogKey,
                        timeoutMs: QUICK_CHAT_DYNAMIC_CONTEXT_TIMEOUT_MS,
                    },
                );
                resolve(EMPTY_DYNAMIC_CONTEXTS);
            }, QUICK_CHAT_DYNAMIC_CONTEXT_TIMEOUT_MS);
        });

        logQuickChatPerfStage(
            quickChatPerfStartedAt,
            "stream-agent-dynamic-context-starting",
            {
                responseApi: isResponseAPIModel(agentConfig),
            },
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

const finalizeQuickChatAgentTurnFailure = async (
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
            : "未能启动模型回复，请重试。";

    await dispatch(
        messageStreamEnd({
            finalContentBuffer: [
                {
                    type: "text",
                    text: `[错误: ${reason}]`,
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

const normalizeAgentRunUserInput = (userInput: string | any[]) => {
    if (typeof userInput === "string") {
        return userInput;
    }
    if (!Array.isArray(userInput)) {
        return "";
    }
    return userInput.filter((part) => {
        if (!part || typeof part !== "object") return false;
        if (part.type === "text") return typeof part.text === "string";
        return (
            part.type === "image_url" &&
            typeof part.image_url?.url === "string" &&
            !!part.image_url.url.trim()
        );
    });
};

const isSimpleTextInput = (userInput: string | any[]) => {
    if (typeof userInput === "string") return true;
    if (!Array.isArray(userInput)) return false;
    return userInput.every(
        (part) =>
            part &&
            typeof part === "object" &&
            part.type === "text" &&
            typeof part.text === "string",
    );
};

const canUseQuickChatEmptyDynamicContexts = (
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

const QUICK_CHAT_DIRECT_ANSWER_PATTERN =
    /(只回复|只输出|只回答|直接回复|直接回答|不要解释|无需解释|不用解释|简短回答|一句话)/i;
const QUICK_CHAT_TOOL_INTENT_PATTERN =
    /(调用|转交|agent|助手|应用|网页|页面|图表|图片|生成图|画图|删除|清理|空间|商品|链接|https?:\/\/|www\.|@)/i;

const shouldDisableQuickChatToolsForDirectAnswer = (
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

const classifyQuickChatAccessError = (accessError: string) => {
    if (accessError.includes("获取用户余额")) return "balance-loading";
    if (accessError.includes("余额")) return "balance";
    if (accessError.includes("白名单")) return "whitelist";
    if (accessError.includes("定价")) return "pricing";
    return "unknown";
};

const isUsableAgentConfig = (value: unknown): value is Agent =>
    !!value &&
    typeof value === "object" &&
    (value as any).__ssrPreviewOnly !== true &&
    typeof (value as Agent).dbKey === "string" &&
    !!(value as Agent).dbKey &&
    typeof (value as Agent).model === "string" &&
    !!(value as Agent).model &&
    typeof (value as Agent).provider === "string" &&
    !!(value as Agent).provider;

const extractAgentRunUserText = (userInput: string | any[]) => {
    if (typeof userInput === "string") {
        return userInput;
    }
    if (!Array.isArray(userInput)) {
        return "";
    }
    return userInput
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
};

const hasAgentRunUserInputContent = (userInput: string | any[]) => {
    if (typeof userInput === "string") {
        return userInput.trim().length > 0;
    }
    return Array.isArray(userInput) && userInput.length > 0;
};

const isLastMessageMatchingUserInput = (visibleMessages: any[], userInput: any): boolean => {
    if (visibleMessages.length === 0) return false;
    const lastMsg = visibleMessages[visibleMessages.length - 1];
    if (lastMsg.role !== "user") return false;

    const content1 = lastMsg.content;
    const content2 = userInput;

    const normalize = (content: any) => {
        if (typeof content === "string") {
            return content.trim();
        }
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

const setLoopStopReason = (reason: string) => {
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
const prewarmPreparedToolsForAgent = (agentConfig: Agent) => {
    const tools = (agentConfig as any)?.tools;
    if (!Array.isArray(tools) || tools.length === 0) return;
    try {
        prepareTools(tools, { provider: (agentConfig as any).provider });
    } catch {
        // ignore prewarm errors
    }
};

const buildStaticContextsWithToolsPrewarm = async (
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

/**
 * 真正用于“聊天轮次”的流式 Agent 调用（带 Agent Loop）：
 * - 每轮检查权限 & 余额
 * - 每轮重建上下文 & 消息
 * - 调用 Completions/Response API
 * - 对 Completions 模型，基于 tool_calls / handoff / pending 决定是否继续
 */
export const streamAgentChatTurnHandler = async (
    args: StreamAgentChatTurnArgs,
    thunkApi: any,
) => {
    const {
        agentKey,
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
        // 1. 读取 Agent 配置。
        const cachedAgentConfig = selectById(
            getState() as RootState,
            agentKey,
        );
        let rawAgentConfig: Agent | null = null;

        rawAgentConfig = isUsableAgentConfig(cachedAgentConfig)
            ? cachedAgentConfig
            : await readAgentConfigForTurn(
                dispatch,
                agentKey,
                quickChatPerfStartedAt,
            );
        if (!rawAgentConfig) {
            return rejectWithValue(
                `Agent config not found for ID: ${agentKey}`,
            );
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
            source: rawAgentConfig === cachedAgentConfig ? "cache" : "read",
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
                    if (accumulated.length <= 0) return;
                    await persistMessageWithFixedId(dispatch, buildMachineAssistantMessage());
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
                        // onAbort 已完成清理/持久化;保持和原实现一致的提前退出。
                        return;
                    }
                    if (result.outcome === "streamEnded") {
                        if (!result.sawDone) {
                            // 连接被静默中断:没有收到完成信号,视为异常终止,
                            // 保留已累积内容并标记错误,而不是当成完整回复落库。
                            dispatch(finalizeTransientMessageOnError({
                                id: messageId,
                                error: "电脑端 Agent 流式响应被中断,未收到完成信号",
                            }));
                            remoteTransientMessageFinalized = true;
                            setLoopStopReason("error");
                            return rejectWithValue(
                                "电脑端 Agent 流式响应被中断,未收到完成信号",
                            );
                        }
                        await persistMessageWithFixedId(dispatch, buildMachineAssistantMessage());
                        remoteTransientMessageFinalized = true;
                    }
                } finally {
                    try {
                        await reader.cancel();
                    } catch {
                        // ignore
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
                    },
                });

                if (result.outcome === "rejected") {
                    return await rejectCliStream(result.message);
                }
                if (result.outcome === "aborted") {
                    // onAbort 已完成清理/持久化;保持和原实现一致的提前退出。
                    return;
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
            const assistantSegments: {
                key: string;
                messageId: string;
                content: string;
                finalized: boolean;
            }[] = [];
            let assistantMessageKeys: { key: string; messageId: string } | null = null;
            let streamResult: any = null;
            let streamError: string | null = null;
            const activeToolMessages = new Map<string, any>();
            const ensureAssistantMessageKeys = () => {
                if (!assistantMessageKeys) {
                    assistantMessageKeys = createDialogMessageKeyAndId(dialogId);
                    assistantSegments.push({
                        key: assistantMessageKeys.key,
                        messageId: assistantMessageKeys.messageId,
                        content: "",
                        finalized: false,
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
            // When a tool call arrives and the current assistant text segment is
            // non-empty, finalize that segment so the tool card renders in its
            // true position: the running segment stops accepting deltas, and the
            // next delta starts a brand-new assistant message (new id) whose
            // record-order position follows the tool message. An empty segment
            // (tool called before any text) is reused to avoid an empty bubble.
            const finalizeCurrentAssistantSegmentForTool = () => {
                if (currentContent.length === 0) return;
                const segment = assistantSegments[assistantSegments.length - 1];
                segment.content = currentContent;
                segment.finalized = true;
                // Mark the just-streamed segment as no longer streaming so the UI
                // stops showing the spinner on it; drop the reference so the next
                // delta mints a new id. currentContent is reset for the next segment.
                if (assistantMessageKeys) {
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
                    } else if (event.type === "tool") {
                        const toolEvent = event.event;
                        const callId = toolEvent.toolCallId;
                        if (!callId) continue;

                        if (toolEvent.type === "tool-call") {
                            // Finalize the running assistant text segment before the
                            // tool card is created, so the next text segment lands
                            // after this tool message in record order.
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
                for (const segment of assistantSegments) {
                    if (segment.content.trim().length > 0) {
                        await persistMessageWithFixedId(dispatch, {
                            id: segment.messageId,
                            dbKey: segment.key,
                            role: "assistant",
                            content: segment.content,
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
                return;
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
                // Assistant text: keep partial stream and mark the turn error.
                for (const segment of assistantSegments) {
                    dispatch(finalizeTransientMessageOnError({
                        id: segment.messageId,
                        error: errorText,
                    }));
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
            const earlierFinalizedSegments = assistantSegments.filter(
                (segment) => segment.finalized && segment.content.length > 0
            );
            for (const segment of earlierFinalizedSegments) {
                dispatch(write({
                    data: {
                        id: segment.messageId,
                        dbKey: segment.key,
                        dialogId,
                        content: segment.content,
                        role: "assistant",
                        isStreaming: false,
                        type: DataType.MSG,
                        ...desktopMessageMetadata,
                    },
                    customKey: segment.key,
                }));
            }

            const { key: msgKey, messageId } = ensureAssistantMessageKeys();
            const lastSegmentContent = streamResult.content || currentContent || "";
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

            await dispatch(messageStreamEnd({
                finalContentBuffer: [
                    {
                        type: "text",
                        text: lastSegmentContent,
                    },
                ],
                totalUsage: streamResult.usage ?? undefined,
                messageId,
                msgKey,
                agentConfig,
                dialogId,
                dialogKey,
                reasoningBuffer: "",
                toolCalls: extractDesktopRuntimeToolCallsForUi(desktopTurnMessages),
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
                    if (accumulated.length <= 0) return;
                    await persistMessageWithFixedId(dispatch, buildRemoteAssistantMessage());
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
                        // onAbort 已完成清理/持久化;保持和原实现一致的提前退出。
                        return;
                    }
                    if (result.outcome === "streamEnded") {
                        if (!result.sawDone) {
                            // 连接被静默中断:没有收到完成信号,视为异常终止,
                            // 保留已累积内容并标记错误,而不是当成完整回复落库。
                            dispatch(finalizeTransientMessageOnError({
                                id: messageId,
                                error: "远端 Agent 流式响应被中断,未收到完成信号",
                            }));
                            remoteTransientMessageFinalized = true;
                            setLoopStopReason("error");
                            return rejectWithValue(
                                "远端 Agent 流式响应被中断,未收到完成信号",
                            );
                        }
                        await persistMessageWithFixedId(dispatch, buildRemoteAssistantMessage());
                        remoteTransientMessageFinalized = true;
                    }
                } finally {
                    try {
                        await reader.cancel();
                    } catch {
                        // ignore
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
                    break;
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
                    const agentHasVision = resolveAgentImageInputSupport(
                        agentConfigForCall as any,
                    );

                    if (!agentHasVision && hasImageInMessages(processedMessages)) {
                        setLoopStopReason("error");
                        return rejectWithValue(
                            "当前 Agent 不支持图片输入，请改用文本或文档。",
                        );
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
                });
                logQuickChatPerfStage(quickChatPerfStartedAt, "stream-agent-model-request-finished", {
                    responseApi: true,
                    hasToolCalls: meta.hasToolCalls,
                    hasHandedOff: meta.hasHandedOff,
                    hasPendingInteraction: meta.hasPendingInteraction,
                });

                appendTempUserInput = false;
                currentParentMessageId = undefined;
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
                break;
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
                const agentHasVision = resolveAgentImageInputSupport(
                    agentConfigForCall as any,
                );

                if (!agentHasVision && hasImageInMessages(processedMessages)) {
                    setLoopStopReason("error");
                    return rejectWithValue(
                        "当前 Agent 不支持图片输入，请改用文本或文档。",
                    );
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
            return;
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
