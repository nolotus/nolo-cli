import { clipCompactText } from "../core/clipCompactText";
import { toErrorMessage } from "../core/errorMessage";

import type {
  AgentRuntimeHostAdapter,
  AgentRuntimeProvider,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import type { ActionGate } from "./actionGate";
import { readActionGate, readCommandActionGatePayload } from "./actionGate";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeMessageContent,
  AgentRuntimeOutputBlock,
  AgentRuntimeResult,
  AgentRuntimeToolCall,
} from "./types";
import { sanitizeToolCallPairing } from "./toolCallPairing";
import { summarizeToolArguments } from "./summarizeToolArguments";
import { buildIdentityBlock } from "./identityBlock";
import { resolveAgentImageInputSupport } from "../ai/llm/agentCapabilities";
import { buildRuntimeGuidanceBlocks } from "./runtimeGuidance";
import { canonicalizeToolNames } from "./toolNameAliases";
import { buildCurrentTimeBlock } from "./currentTimeContext";
import type { ContextBlockScope } from "./contextBlockScope";
import { normalizeContextBlockScopes } from "./contextBlockScope";
import {
  MAX_HISTORICAL_TOOL_CONTENT_CHARS,
  FRESH_TOOL_OUTPUT_MAX_CHARS,
  clipToolText,
  resolveToolOutputProfile,
} from "../ai/agent/toolOutputPolicy";
import { planContextUsage } from "../ai/context/retention";
import { estimateTokenCount } from "../ai/context/tokenUtils";
import { getModelContextWindow } from "../ai/llm/getModelContextWindow";
import { maybeAutoCompactLocalHistory } from "./localAutoCompaction";

export type LocalAgentTurnInput = {
  adapter: AgentRuntimeHostAdapter;
  agentRef: string;
  input: AgentRuntimeMessageContent;
  /**
   * Optional expanded input used only when persisting a runtime reference
   * (for example a TUI paste). Provider messages keep the compact reference;
   * the durable dialog keeps the complete user input.
   */
  persistedInput?: AgentRuntimeMessageContent;
  /** Compact provider-visible form for the durable persistedInput. */
  persistedInputReference?: AgentRuntimeMessageContent;
  /**
   * Returns true only when the current host can resolve a persisted context
   * reference. Unresolvable references fall back to durable content so a
   * resumed dialog never sends a dead pointer to a model.
   */
  contextReferenceResolver?: (reference: AgentRuntimeMessageContent) => boolean;
  continueDialogId?: string;
  spaceId?: string;
  /**
   * Runtime-assembled context blocks (space/workspace layers from
   * turnContext.ts). Appended after the agent prompt inside the same
   * system message so every host surface shares identical semantics.
   */
  contextBlocks?: string[];
  /**
   * Context blocks with cacheScope metadata. When provided, `buildMessages`
   * splits the system message into a stable prefix (session-scope blocks +
   * agent prompt) and a dynamic suffix (turn-scope blocks), enabling
   * Claude cache_control breakpoints and DeepSeek auto prefix-cache hits.
   * Falls back to `contextBlocks` by converting each legacy block to a
   * turn-scope block once.
   */
  contextBlockScopes?: ContextBlockScope[];
  category?: string;
  inheritedFromDialogKey?: string;
  parentDialogId?: string;
  runtimeContext?: Record<string, any> | null;
  timeoutMs?: number;
  background?: boolean;
  noStream?: boolean;
  onToolEvent?: (event: LocalAgentToolEvent) => void;
  onActionGate?: (gate: LocalAgentActionGate) => Promise<AgentRuntimeToolResult | void>;
  onTextDelta?: (chunk: string) => void;
  /**
   * 端侧 reasoning 增量透传（第一层）。provider.complete 收到 reasoning
   * 增量时回调，与 onTextDelta 同模式。端侧（desktop handler / CLI 显示）
   * 接入是后续 Task B，本字段只打通 localLoop 接口层与 provider 读取路径。
   */
  onReasoningDelta?: (chunk: string) => void;
  onLoopEvent?: (event: LocalAgentLoopEvent) => void;
  /**
   * 单次 provider.complete 的可选硬超时。
   * 未设置时：若本回合传了 timeoutMs 则继承之；否则不限时（coding loop 常跑很久，禁止默认 120s 杀请求）。
   */
  llmRequestTimeoutMs?: number;
  /**
   * 协作式停止（用户按 Esc 等）。在轮次边界和每个工具执行前检查，并与
   * provider.complete race。provider 没有取消契约，在途请求会被放弃而不是
   * 真正撤销；中断的回合仍会 saveTurn 留档。
   */
  abortSignal?: AbortSignal;
};

export type LocalAgentTurnResult = AgentRuntimeResult & {
  dialogId: string;
  turnMessages?: AgentRuntimeChatMessage[];
};

export type LocalAgentToolEvent = {
  type: "tool-call" | "tool-result" | "tool-error";
  round: number;
  toolCallId: string;
  toolName: string;
  argumentsPreview?: string;
  elapsedMs?: number;
  summary?: string;
  /** Full tool result text for UI expand (model path still uses turn messages). */
  content?: string;
  message?: string;
  metadata?: Record<string, unknown>;
};

export type LocalAgentContextMetrics = {
  messageCount: number;
  contentChars: number;
  toolMessageCount: number;
  rawToolContentChars: number;
  projectedToolContentChars: number;
  truncatedToolResults: number;
  stableContextChars: number;
  dynamicContextChars: number;
};

export type LocalAgentLoopEvent =
  | {
      kind: "llm-start";
      round: number;
      atMs: number;
      context?: LocalAgentContextMetrics;
    }
  | {
      kind: "llm-end";
      round: number;
      atMs: number;
      ok: boolean;
      /** Per-request cache metrics from provider usage, for token-level analysis. */
      cache?: {
        inputTokens: number;
        outputTokens: number;
        cacheHitTokens: number;
        cacheMissTokens: number;
        hitRatio: number;
      };
    }
  | { kind: "tool-start"; name: string; atMs: number }
  | { kind: "tool-end"; name: string; atMs: number; ok: boolean }
  | { kind: "image-downgraded"; reason: "no-vision"; atMs: number };

export type LocalAgentActionGate = ActionGate & {
  toolName: string;
  toolCallId: string;
};

export const LOCAL_AGENT_CONFIG_MISSING_CODE = "LOCAL_AGENT_CONFIG_MISSING";

/**
 * 空轮修复共享常量。
 *
 * 这些文案常量与判定语义由 `packages/server/handlers/agentRun/loopMessageExtract.ts`
 * 的空轮处置流程首次落地，现下沉到 agent-runtime 共享层，使 CLI local 与
 * 桌面 local turn（都消费 `runLocalAgentTurn`）与服务端 loop 行为一致。
 * 服务端 loop 通过 `../../../agent-runtime` 引用同一常量，仅替换常量来源，
 * 不动其判定/流程逻辑。
 *
 * 语义要点（与服务端逐条对齐）：
 * - reasoning_content 不计入可见输出——reasoning-only 且无 tool_calls 视为空轮，走 repair/fallback；
 * - finish_reason === "length" 单独兜底为 LENGTH_TRUNCATED_FALLBACK_MESSAGE，不走 repair。
 */
export const EMPTY_ASSISTANT_REPAIR_PROMPT =
  "请给出明确的文字回答或执行下一步：如果任务已完成，请直接总结结果；如果需要调用工具，请直接输出 tool_calls。请切勿返回空内容。";
export const EMPTY_ASSISTANT_FALLBACK_MESSAGE =
  "模型连续返回空消息，当前任务未完成。请重试当前步骤，或给出更具体的修改范围。";

/**
 * length 截断兜底文案。与服务端 loopMessageExtract.LENGTH_TRUNCATED_FALLBACK_MESSAGE 逐字一致：
 * 模型因输出长度上限被截断（finish_reason === "length"）时，不再重试，直接以此文案结束，
 * 给用户一个明确诊断，而不是空串。
 */
export const LENGTH_TRUNCATED_FALLBACK_MESSAGE =
  "输出达到长度上限被截断，建议缩短任务或提高输出上限。";

/**
 * 上游流被中途切断（而不是模型真的没话说）时的文案。与服务端
 * loopMessageExtract.STREAM_TRUNCATED_FALLBACK_MESSAGE 逐字一致。
 *
 * 判据是「完全没有 finish_reason」：健康的 OpenAI 兼容流最后一个 chunk 必带它，
 * 拿不到就说明流在收尾前就断了。实测过两种成因：代理侧把整个 fetch 连同正在
 * 流式返回的 body 一起 abort（已在 providerGateway 修掉），以及上游自己提前
 * 关闭连接。两者对客户端的表征相同，且都会伪装成「模型返回空内容」。
 */
export const STREAM_TRUNCATED_FALLBACK_MESSAGE =
  "上游响应流在收尾前被中断（未收到结束标记），本轮输出不完整。请重试当前步骤。";

/**
 * 判定空 assistant 回复的处置方式。语义与 server loopMessageExtract 完全一致：
 *
 * - 有 tool calls 或可见输出（文本/图片） → ok
 * - finishReason === "length" → fallback/length_truncated（不走 repair；模型已被截断，重试无意义）
 * - 未用过 repair → repair（注入 repair system message 重试一次；截断多为瞬时故障，重试是对的）
 * - 用过 repair 且始终没有 finishReason → fallback/stream_truncated（流被切断，不是模型空）
 * - 用过 repair → fallback/empty_completion（以诊断文案结束）
 *
 * - reasoning_content 不计入可见输出：reasoning-only 且无 tool_calls 视为空轮，
 *   走 repair/fallback，与 length 截断分支各自独立兜底。
 */
export type EmptyAssistantFallbackReason =
  | "empty_completion"
  | "length_truncated"
  | "stream_truncated";

export function resolveEmptyAssistantOutcome(args: {
  hasToolCalls: boolean;
  hasVisibleOutput: boolean;
  repairUsed: boolean;
  finishReason?: string;
  /**
   * 流收到了收尾元数据帧。有这个证据时它压过「缺 finish_reason」的推断——
   * 见 AgentRuntimeResult.stream_complete：确实存在从不发 finish_reason 的上游。
   */
  streamComplete?: boolean;
}):
  | { kind: "ok" }
  | { kind: "repair" }
  | { kind: "fallback"; reason: EmptyAssistantFallbackReason } {
  if (args.hasToolCalls || args.hasVisibleOutput) return { kind: "ok" };
  if (args.finishReason === "length") return { kind: "fallback", reason: "length_truncated" };
  if (!args.repairUsed) return { kind: "repair" };
  if (!args.finishReason && !args.streamComplete) {
    return { kind: "fallback", reason: "stream_truncated" };
  }
  return { kind: "fallback", reason: "empty_completion" };
}

/**
 * 成因 → 用户可见文案。三种成因各自指向不同的排查方向，
 * 退化成同一句会把方向带偏，所以这里是唯一的映射点。
 */
export function resolveEmptyAssistantFallbackMessage(
  reason: EmptyAssistantFallbackReason,
): string {
  if (reason === "length_truncated") return LENGTH_TRUNCATED_FALLBACK_MESSAGE;
  if (reason === "stream_truncated") return STREAM_TRUNCATED_FALLBACK_MESSAGE;
  return EMPTY_ASSISTANT_FALLBACK_MESSAGE;
}

/** assistant 是否产生了可见输出（文本/图片）。tool_calls 由调用方单独判定。
 *  reasoning_content 不算可见输出——与服务端 loopMessageExtract.hasAssistantVisibleOutput 一致：
 *  reasoning-only 且无 tool_calls 视为空轮，走 repair/fallback，避免用户只看到空串。 */
export function hasAssistantVisibleOutput(
  content: AgentRuntimeMessageContent,
): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (part?.type === "text" && String(part.text ?? "").trim()) return true;
    if (part?.type === "image_url") {
      const url = part?.image_url?.url;
      return typeof url === "string" && url.trim().length > 0;
    }
    return false;
  });
}

function formatToolExecutionError(args: {
  toolName: string;
  error: unknown;
}) {
  const message = toErrorMessage(args.error);
  return `${args.toolName} failed: ${message}`;
}

function formatStructuredToolExecutionError(args: {
  toolName: string;
  error: unknown;
}) {
  if (!args.error || typeof args.error !== "object") return null;
  const error = args.error as {
    code?: unknown;
    message?: unknown;
    policy?: unknown;
    permissionRequest?: unknown;
  };
  if (typeof error.code !== "string") return null;
  return JSON.stringify({
    error: error.code,
    message:
      typeof error.message === "string"
        ? error.message
        : formatToolExecutionError(args),
    ...(error.policy && typeof error.policy === "object"
      ? { policy: error.policy }
      : {}),
    ...(error.permissionRequest && typeof error.permissionRequest === "object"
      ? { permissionRequest: error.permissionRequest }
      : {}),
  });
}

function shouldReturnToolExecutionErrors(adapter: AgentRuntimeHostAdapter) {
  return adapter.capabilities.includes("local-tools");
}

function emitToolEvent(
  input: LocalAgentTurnInput,
  event: LocalAgentToolEvent
) {
  input.onToolEvent?.(event);
}

function emitLoopEvent(input: LocalAgentTurnInput, event: LocalAgentLoopEvent) {
  if (!input.onLoopEvent) return;
  try {
    input.onLoopEvent(event);
  } catch {
    // 观测方回调异常必须被吞掉，不允许影响 loop 正确性
  }
}

const LLM_REQUEST_TIMEOUT = "LLM_REQUEST_TIMEOUT";

export const LOCAL_TURN_ABORTED_CODE = "LOCAL_TURN_ABORTED";

function buildAbortedError(): Error & { code?: string } {
  const error = new Error("local agent turn aborted by user") as Error & {
    code?: string;
  };
  error.code = LOCAL_TURN_ABORTED_CODE;
  return error;
}

function throwIfAborted(input: LocalAgentTurnInput) {
  if (input.abortSignal?.aborted) throw buildAbortedError();
}

/**
 * 与 runCompleteWithTimeout 里的 abort racer 同构：signal 触发即抛
 * LOCAL_TURN_ABORTED，不等被 race 的 promise 结束。用于工具执行——
 * executeTool 大多不接收 abortSignal，abort 后必须放弃等待、把控制权
 * 交还给上层（execShell 自己消费 signal，会真被 SIGTERM/SIGKILL 掉）。
 *
 * 被放弃的 promise 不取消（取消是各工具自己的契约），只挂空 catch 防
 * unhandled rejection；pendingToolName 透出「中止时 <toolName> 仍在进行，
 * 它可能已经完成」。
 */
async function raceWithAbort<T>(
  input: LocalAgentTurnInput,
  promise: Promise<T>,
  pendingToolName?: string,
): Promise<T> {
  const signal = input.abortSignal;
  if (!signal) return promise;
  let abortListener: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      const error = buildAbortedError() as Error & { pendingToolName?: string };
      if (pendingToolName) error.pendingToolName = pendingToolName;
      promise.catch(() => {});
      reject(error);
    };
    if (signal.aborted) {
      abortListener();
      return;
    }
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    // 与 runCompleteWithTimeout 一致：必须清 listener，否则多轮 turn 会在
    // 同一个 signal 上堆积几十个 listener（Node 到 11 个即打
    // MaxListenersExceededWarning）。
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function resolveLlmRequestTimeoutMs(input: LocalAgentTurnInput): number | undefined {
  const raw = input.llmRequestTimeoutMs ?? input.timeoutMs;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw;
}

async function runCompleteWithTimeout(args: {
  provider: { complete(messages: AgentRuntimeChatMessage[], options?: any): Promise<AgentRuntimeResult> };
  messages: AgentRuntimeChatMessage[];
  options: Record<string, unknown>;
  /** 未设置 = 不硬超时，等 provider 自然结束。 */
  timeoutMs?: number;
  round: number;
  input: LocalAgentTurnInput;
  context?: LocalAgentContextMetrics;
}): Promise<AgentRuntimeResult> {
  const { provider, messages, options, timeoutMs, round, input, context } = args;

  emitLoopEvent(input, {
    kind: "llm-start",
    round,
    atMs: Date.now(),
    ...(context ? { context } : {}),
  });
  const complete = provider.complete(messages, options);
  let ok = false;

  const signal = input.abortSignal;
  let abortListener: (() => void) | undefined;
  const racers: Promise<never>[] = [];
  if (signal) {
    racers.push(
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(buildAbortedError());
        if (signal.aborted) {
          abortListener();
          return;
        }
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  // No default hard timeout: multi-round coding loops regularly exceed minutes.
  // Only race a timer when the caller explicitly opts in.
  if (typeof timeoutMs === "number") {
    racers.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`__llm_timeout__:${timeoutMs}`));
        }, timeoutMs);
      }),
    );
  }

  let result: AgentRuntimeResult | undefined;
  try {
    result =
      racers.length === 0 ? await complete : await Promise.race([complete, ...racers]);
    ok = true;
    return result;
  } catch (error) {
    const isTimeout =
      error instanceof Error && error.message.startsWith("__llm_timeout__:");
    if (!isTimeout) throw error;
    // provider.complete has no cancellation contract. Retrying here would leave
    // the timed-out CLI process alive and start a duplicate invocation.
    const timeoutError = new Error(
      `LLM request timed out after ${timeoutMs}ms (round ${round})`,
    ) as Error & { code?: string };
    timeoutError.code = LLM_REQUEST_TIMEOUT;
    throw timeoutError;
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    // Emit llm-end with per-request cache metrics for token-level analysis
    const usage = result?.usage;
    const cacheHit = Number(usage?.cache_read_input_tokens ?? usage?.prompt_cache_hit_tokens ?? 0);
    const cacheMiss = Number(usage?.cache_creation_input_tokens ?? usage?.prompt_cache_miss_tokens ?? 0);
    const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
    const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
    emitLoopEvent(input, {
      kind: "llm-end",
      round,
      atMs: Date.now(),
      ok,
      ...(inputTokens > 0 || cacheHit > 0 || cacheMiss > 0
        ? {
            cache: {
              inputTokens,
              outputTokens,
              cacheHitTokens: cacheHit,
              cacheMissTokens: cacheMiss,
              hitRatio: inputTokens > 0 ? Math.round((cacheHit / inputTokens) * 10000) / 10000 : 0,
            },
          }
        : {}),
    });
  }
}

function clip(value: string, max = 240) {
  return clipCompactText(value, max);
}

function summarizeToolResult(content: unknown, metadata?: Record<string, unknown>) {
  const parts: string[] = [];
  const exitCode = metadata?.exitCode;
  if (typeof exitCode === "number") parts.push(`exit=${exitCode}`);
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed) {
      const lines = trimmed.split(/\r?\n/).length;
      parts.push(`${lines} line${lines === 1 ? "" : "s"}`);
      parts.push(`${trimmed.length} chars`);
      const tail = clip(trimmed.slice(-160), 160);
      if (tail) parts.push(`tail="${tail}"`);
    } else {
      parts.push("empty");
    }
  }
  return parts.join(" ");
}

function formatToolMessageContent(args: {
  toolName: string;
  content: string;
  metadata?: Record<string, unknown>;
}) {
  if (
    (
      args.toolName !== "listFiles" &&
      args.toolName !== "globFiles" &&
      args.toolName !== "searchFiles" &&
      args.toolName !== "readFile"
    ) ||
    !args.metadata ||
    Object.keys(args.metadata).length === 0
  ) {
    return args.content;
  }
  return `${args.content}\n\n[tool metadata]\n${JSON.stringify(args.metadata)}`;
}

/**
 * 把 provider 返回的有序 output blocks（text→toolCall→text）展开为 OpenAI 扁平消息：
 * assistant(text_before | null, tool_calls[]) → tool(tool_call_id, content) → …
 * 连续 toolCall 无中间 text → 合并进同一条 assistant 的 tool_calls[]。
 * thinking → 折进该段 assistant 的 reasoning_content（不单独成 role）。
 * 末尾 text → 追加一条无 tool_calls 的 assistant。
 * 仅供 localLoop output 分支调用，不重跑工具（result 已由流内执行填充）。
 */
function blocksToOpenAiMessages(
  blocks: AgentRuntimeOutputBlock[],
): AgentRuntimeChatMessage[] {
  const out: AgentRuntimeChatMessage[] = [];
  let text = "";
  let reasoning = "";
  let pendingToolCalls: AgentRuntimeToolCall[] = [];
  let pendingToolResults: { content: string; metadata?: Record<string, unknown> }[] = [];

  const flushSegment = () => {
    if (text === "" && pendingToolCalls.length === 0 && reasoning === "") return;
    out.push({
      role: "assistant",
      content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(pendingToolCalls.length > 0 ? { tool_calls: pendingToolCalls } : {}),
    });
    for (let i = 0; i < pendingToolCalls.length; i += 1) {
      const tc = pendingToolCalls[i];
      const res = pendingToolResults[i];
      out.push({
        role: "tool",
        content: formatToolMessageContent({
          toolName: tc.function.name,
          content: res?.content ?? "",
          ...(res?.metadata ? { metadata: res.metadata } : {}),
        }),
        tool_call_id: tc.id,
        toolName: tc.function.name,
        ...(res?.metadata ? { tool_result_metadata: res.metadata } : {}),
      });
    }
    text = "";
    reasoning = "";
    pendingToolCalls = [];
    pendingToolResults = [];
  };

  for (const block of blocks) {
    if (block.type === "text") {
      // toolCalls 已挂起 → 先 flush assistant+tools，再开新 text 段
      if (pendingToolCalls.length > 0) {
        flushSegment();
      }
      text += block.text;
      continue;
    }
    if (block.type === "thinking") {
      reasoning += block.thinking;
      continue;
    }
    if (block.type === "toolCall") {
      pendingToolCalls.push(block.toolCall);
      pendingToolResults.push({
        content: block.result?.content ?? "",
        ...(block.result?.metadata ? { metadata: block.result.metadata } : {}),
      });
    }
  }
  flushSegment();
  return out;
}

function buildActionGate(args: {
  toolName: string;
  toolCallId: string;
  metadata?: Record<string, unknown>;
}): LocalAgentActionGate | null {
  const gate = readActionGate(args.metadata?.actionGate);
  if (!gate) return null;
  if (gate.kind === "handoff" && !readCommandActionGatePayload(gate.payload)) return null;
  return {
    ...gate,
    toolName: args.toolName,
    toolCallId: args.toolCallId,
  };
}

const TOOL_METADATA_KEYS = [
  "path",
  "query",
  "effectivePattern",
  "startLine",
  "endLine",
  "totalLines",
  "totalBytes",
  "bytes",
  "totalChars",
  "count",
  "matchCount",
  "matchedFiles",
  "truncated",
  "limitedByMaxResults",
  "limitedByMaxDepth",
  "visitedEntries",
  "maxResults",
  "exitCode",
  "status",
  "timedOut",
  "aborted",
  "replacements",
  "code",
  "error",
  "message",
  "warnings",
  "pasteId",
  "source",
] as const;

/**
 * 按模型上下文预算裁掉最老的历史消息。
 *
 * 为什么需要：localLoop 此前把完整历史无条件发给 provider，没有任何窗口或压缩。
 * 实测本地对话里有末轮上下文达 10.2M token 的会话，而 deepseek-v4-flash 的窗口
 * 是 100 万——这类请求要么失败，要么被 provider 静默截断（模型在缺失上下文的
 * 情况下继续作答，且无人知晓）。
 *
 * 预算判定复用 web 端同一个纯函数 `planContextUsage`，不在 CLI 侧另造一套阈值。
 * 该规划器是 cache-first 的：1M 窗口模型的历史预算约 94 万 token，所以本裁剪
 * 只在接近撞窗口时才生效，正常会话完全不受影响、provider 前缀缓存不被破坏。
 *
 * 裁剪后必须过 `sanitizeToolCallPairing`：从头部丢消息可能丢掉声明 tool_calls 的
 * assistant 却留下对应的 tool 结果，provider 会直接报错。
 */
export function trimHistoryToContextBudget(
  history: AgentRuntimeChatMessage[],
  model: string | undefined,
): { history: AgentRuntimeChatMessage[]; droppedCount: number } {
  if (history.length === 0) return { history, droppedCount: 0 };

  const { rawMessageBudget } = planContextUsage({
    contextWindow: getModelContextWindow(model ?? ""),
    summaryTokens: 0,
    // localLoop 没有 web 端的负载分档器；medium 是中性默认值，
    // 不为了省几个 token 在这里复制一份分类逻辑。
    recentLoad: "medium",
  });

  // 必须用 estimateTokenCount：它是中文感知的（中文 1.5 tok/字，其他 0.25 tok/字符）。
  // 平铺 chars/4 对中文低估约 6 倍，会导致中文会话该裁不裁、照旧撞窗口。
  const messageTokens = (message: AgentRuntimeChatMessage): number => {
    const toolCalls = (message as any).tool_calls;
    return (
      estimateTokenCount(contentAsText(message.content)) +
      (Array.isArray(toolCalls) ? estimateTokenCount(JSON.stringify(toolCalls)) : 0)
    );
  };

  let used = 0;
  let start = history.length;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const cost = messageTokens(history[i]);
    // 至少保留最后一条，否则预算极小时会裁成空历史
    if (used + cost > rawMessageBudget && start < history.length) break;
    used += cost;
    start = i;
  }

  if (start === 0) return { history, droppedCount: 0 };
  return {
    history: sanitizeToolCallPairing(history.slice(start)),
    droppedCount: start,
  };
}

/** 把结构化 content 摊平成文本，供中文感知的 estimateTokenCount 使用。 */
function contentAsText(content: AgentRuntimeMessageContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text;
      if (part?.type === "image_url") return part.image_url.url;
      return "";
    })
    .join("\n");
}

function contentCharCount(content: AgentRuntimeMessageContent): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => {
    if (part?.type === "text") return total + part.text.length;
    if (part?.type === "image_url") return total + part.image_url.url.length;
    return total;
  }, 0);
}

function compactToolMetadata(
  metadata: Record<string, unknown> | undefined,
): string {
  if (!metadata) return "";
  const selected: Record<string, unknown> = {};
  for (const key of TOOL_METADATA_KEYS) {
    const value = metadata[key];
    if (value === undefined) continue;
    if (typeof value === "string") {
      selected[key] = clipCompactText(value, 240);
      continue;
    }
    if (Array.isArray(value)) {
      selected[key] = value.slice(0, 20).map((item) =>
        typeof item === "string"
          ? clipCompactText(item, 180)
          : clipCompactText(JSON.stringify(item), 180),
      );
      continue;
    }
    selected[key] = value;
  }
  return Object.keys(selected).length > 0
    ? clipCompactText(JSON.stringify(selected), 1200)
    : "";
}

function projectToolContentForProvider(args: {
  content: AgentRuntimeMessageContent;
  toolName?: string;
  metadata?: Record<string, unknown>;
  maxChars: number;
  label: string;
}): AgentRuntimeMessageContent {
  const content = args.content;
  if (typeof content !== "string") return content;
  const metadataText = compactToolMetadata(args.metadata);
  // Some tool formatters already append the full metadata JSON to the durable
  // content. Remove that provider-side duplicate and re-add the bounded
  // projection below so metadata cannot disappear in the clipped middle/tail.
  const embeddedMetadataIndex = metadataText
    ? content.indexOf("\n\n[tool metadata]\n")
    : -1;
  const contentForProjection = embeddedMetadataIndex >= 0
    ? content.slice(0, embeddedMetadataIndex)
    : content;
  const metadataSuffix = metadataText
    ? `\n\n[tool metadata]\n${metadataText}`
    : "";
  // Keep already-bounded durable tool messages byte-for-byte stable. This is
  // important for short read/search results whose metadata is already part of
  // the canonical message; projection is only needed once the provider bound
  // would actually be exceeded.
  if (embeddedMetadataIndex >= 0 && content.length <= args.maxChars) {
    return content;
  }
  const headRatio = resolveToolOutputProfile(args.toolName).headRatio;
  const diagnostic = (clippedLength: number) =>
    `[${args.label}; originalChars=${content.length}; omittedChars=${Math.max(
      0,
      content.length - clippedLength,
    )}]`;
  const suffix = (clippedLength: number) =>
    [diagnostic(clippedLength), metadataSuffix.trimStart()]
      .filter(Boolean)
      .join("\n\n");
  const initialBudget = Math.max(
    1,
    args.maxChars - suffix(contentForProjection.length).length - 2,
  );
  let clipped = clipToolText(contentForProjection, initialBudget, headRatio);
  const wasClipped = clipped.length < contentForProjection.trim().length;
  const needsProjection = wasClipped || Boolean(metadataSuffix) || embeddedMetadataIndex >= 0;
  if (!needsProjection) return args.content;

  let projected = wasClipped || metadataSuffix
    ? `${clipped}\n\n${suffix(clipped.length)}`
    : clipped;
  // The first budget is conservative, but the omitted-char count changes the
  // diagnostic length. Tighten once more so maxChars is a real provider bound,
  // including metadata and the truncation marker.
  if (projected.length > args.maxChars) {
    const boundedBudget = Math.max(
      1,
      args.maxChars - suffix(clipped.length).length - 2,
    );
    clipped = clipToolText(contentForProjection, boundedBudget, headRatio);
    projected = `${clipped}\n\n${suffix(clipped.length)}`;
  }
  return projected.length <= args.maxChars
    ? projected
    : projected.slice(0, args.maxChars);
}

type PreparedProviderMessages = {
  messages: AgentRuntimeChatMessage[];
  metrics: LocalAgentContextMetrics;
};

function summarizeHistoricalToolContent(
  content: AgentRuntimeMessageContent,
  toolName?: string,
  metadata?: Record<string, unknown>,
): AgentRuntimeMessageContent {
  const profile = resolveToolOutputProfile(toolName);
  return projectToolContentForProvider({
    content,
    toolName,
    metadata,
    maxChars: Math.min(profile.maxChars, MAX_HISTORICAL_TOOL_CONTENT_CHARS),
    label: "historical tool result truncated for the next turn",
  });
}

function prepareMessagesForProviderCall(
  messages: AgentRuntimeChatMessage[],
): PreparedProviderMessages {
  // 发 provider 前的唯一咽喉点：先修掉 tool_calls/tool 配对违规（孤儿 tool、悬空 tool_calls），
  // 再走原 map。脏历史不能原样发给 OpenAI 兼容接口。
  const paired = sanitizeToolCallPairing(messages);
  // 「最新一轮」= 消息序列末尾最长的一段连续 tool 消息。它们刚由本轮最近的工具调用
  // 产出，下一次 provider 调用要立刻读懂它们，给宽预算 FRESH_TOOL_OUTPUT_MAX_CHARS。
  // 这一段之前的 tool 消息属于同一 turn 内更早的轮次——它们在本轮已经不再是「最新
  // 关注点」，但仍会在每次 provider 调用里重发，必须压回 per-tool profile 的紧上限
  // （resolveToolOutputProfile(toolName).maxChars），否则一个 N 轮工具循环会让上下文
  // 随轮数线性膨胀到 fresh×N。跨 turn 的历史已在 prepareHistoryForNextTurn 走过
  // summarizeHistoricalToolContent，这里不动它们。判定只基于消息序列本身，不引入
  // 任何可变状态/参数链/配置项。See T3.
  let freshRunStart = paired.length;
  while (freshRunStart > 0 && paired[freshRunStart - 1].role === "tool") {
    freshRunStart -= 1;
  }
  let toolMessageCount = 0;
  let rawToolContentChars = 0;
  let projectedToolContentChars = 0;
  let truncatedToolResults = 0;
  const projected = paired.map((message, index) => {
    const { context_reference: _contextReference, ...providerMessage } = message;
    const sanitizedContent =
      providerMessage.content == null
        ? ""
        : typeof providerMessage.content === "string"
          ? providerMessage.content
          : providerMessage.content;

    if (providerMessage.role !== "tool") {
      return {
        ...providerMessage,
        content: sanitizedContent,
      };
    }
    toolMessageCount += 1;
    rawToolContentChars += contentCharCount(sanitizedContent);
    const isFresh = index >= freshRunStart;
    const maxChars = isFresh
      ? FRESH_TOOL_OUTPUT_MAX_CHARS
      : resolveToolOutputProfile(providerMessage.toolName).maxChars;
    const projectedContent = projectToolContentForProvider({
      content: sanitizedContent,
      toolName: providerMessage.toolName,
      metadata: providerMessage.tool_result_metadata,
      maxChars,
      label: "in-turn tool result truncated/projected before next provider call",
    });
    projectedToolContentChars += contentCharCount(projectedContent);
    if (contentCharCount(projectedContent) < contentCharCount(sanitizedContent)) {
      truncatedToolResults += 1;
    }
    return {
      ...providerMessage,
      content: projectedContent,
    };
  });
  return {
    messages: projected,
    metrics: {
      messageCount: projected.length,
      contentChars: projected.reduce((total, message) => total + contentCharCount(message.content), 0),
      toolMessageCount,
      rawToolContentChars,
      projectedToolContentChars,
      truncatedToolResults,
      stableContextChars: 0,
      dynamicContextChars: 0,
    },
  };
}

function prepareHistoryForNextTurn(
  history: AgentRuntimeChatMessage[],
  contextReferenceResolver?: (reference: AgentRuntimeMessageContent) => boolean,
): AgentRuntimeChatMessage[] {
  return history.map((message) => {
    if (
      message.role === "user" &&
      message.context_reference !== undefined &&
      contextReferenceResolver?.(message.context_reference)
    ) {
      return { ...message, content: message.context_reference };
    }
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: summarizeHistoricalToolContent(
        message.content,
        message.toolName,
        message.tool_result_metadata,
      ),
    };
  });
}

/**
 * 剥离单条消息 content 里的 image_url parts。模型不支持图片输入时，发上去会 400
 * "this model does not support image input"，把本来能成功的 local 轮判成失败、
 * fallback 到 server——而 server 端没有 local code 工具，agent 报 blocker。
 * 过滤后空数组返回占位文本（不是 ""），因为主流 Provider API 要求 user 消息
 * content 非空，空串会触发 400 "content is required and must be non-empty"，
 * 又回到误 fallback 的老问题。
 */
const IMAGE_OMITTED_PLACEHOLDER = "[Image content omitted: model does not support image input]";

function stripImagePartsFromContent(
  content: AgentRuntimeMessageContent,
): AgentRuntimeMessageContent {
  if (!Array.isArray(content)) return content;
  const filtered = content.filter((part) => part?.type !== "image_url");
  if (filtered.length === 0) return IMAGE_OMITTED_PLACEHOLDER;
  return filtered as AgentRuntimeMessageContent;
}

/**
 * 按 vision 能力过滤整条消息数组。supportsImages 为 true 时原样返回（catalog 默认）；
 * 为 false 时逐条剥离 image_url parts，保留 text/tool_calls 等其他内容。
 */
function filterImagePartsFromMessages(
  messages: AgentRuntimeChatMessage[],
  supportsImages: boolean,
): AgentRuntimeChatMessage[] {
  if (supportsImages) return messages;
  return messages.map((msg) => ({
    ...msg,
    content: stripImagePartsFromContent(msg.content),
  }));
}

type BuiltMessages = {
  messages: AgentRuntimeChatMessage[];
  stableContextChars: number;
  dynamicContextChars: number;
};

function buildMessages(args: {
  prompt?: string;
  contextBlocks?: string[];
  contextBlockScopes?: ContextBlockScope[];
  history: AgentRuntimeChatMessage[];
  input: AgentRuntimeMessageContent;
  contextReferenceResolver?: (reference: AgentRuntimeMessageContent) => boolean;
}): BuiltMessages {
  // When contextBlockScopes is provided, split into stable (session) + dynamic (turn).
  // The agent prompt is always part of the stable prefix.
  if (args.contextBlockScopes?.length) {
    const blocks = args.contextBlockScopes.filter((b) => b.content.trim());
    const stableParts = [args.prompt?.trim(), ...blocks.filter((b) => b.cacheScope === "session").map((b) => b.content)]
      .filter(Boolean);
    const dynamicParts = blocks
      .filter((b) => b.cacheScope === "turn")
      .map((b) => b.content)
      .map((block) => block.trim())
      .filter(Boolean);
    const stableContent = stableParts.join("\n\n");
    const dynamicContent = dynamicParts.join("\n\n");
    // If there are dynamic blocks, we need to split the system message.
    // For Claude: use content array with cache_control on the stable part.
    // For non-Claude: join stable + dynamic into one string (prefix cache is automatic).
    // The provider layer handles the actual cache_control injection;
    // here we just ensure the stable prefix comes first.
    const systemContent = dynamicContent
      ? `${stableContent}\n\n${dynamicContent}`
      : stableContent;
    return {
      messages: [
        ...(systemContent
          ? [{ role: "system" as const, content: systemContent }]
          : []),
        ...prepareHistoryForNextTurn(args.history, args.contextReferenceResolver),
        { role: "user" as const, content: args.input },
      ],
      stableContextChars: stableContent.length,
      dynamicContextChars: dynamicContent.length,
    };
  }

  // Fallback: plain contextBlocks (no scope split)
  const blocks = (args.contextBlocks ?? [])
    .map((block) => block.trim())
    .filter(Boolean);
  const systemContent = [args.prompt?.trim(), ...blocks]
    .filter(Boolean)
    .join("\n\n");
  return {
    messages: [
      ...(systemContent
        ? [{ role: "system" as const, content: systemContent }]
        : []),
      ...prepareHistoryForNextTurn(args.history, args.contextReferenceResolver),
      { role: "user" as const, content: args.input },
    ],
    stableContextChars: (args.prompt?.trim() ?? "").length,
    dynamicContextChars: blocks.join("\n\n").length,
  };
}

function mergeTurnUsage(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
) {
  if (!next) return current;
  const read = (usage: Record<string, unknown>) => ({
    input: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
    output: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
    cacheHit: Number(
      usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    ),
    cacheMiss: Number(
      usage.cache_creation_input_tokens ?? usage.prompt_cache_miss_tokens ?? 0,
    ),
  });
  const right = read(next);
  const left = current ? read(current) : { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
  return {
    input_tokens: right.input || left.input,
    output_tokens: left.output + right.output,
    cache_read_input_tokens: left.cacheHit + right.cacheHit,
    cache_creation_input_tokens: left.cacheMiss + right.cacheMiss,
  };
}

/**
 * 把一次带外 LLM 调用（目前只有自动压缩的摘要生成）的用量加进本轮 usage。
 *
 * 不能直接用 mergeTurnUsage：它的 input 是 `right.input || left.input`，
 * 取最后一次非零值而非累加——那是为多轮工具循环设计的（每轮 input 是累积
 * 上下文，相加会重复计数）。但摘要是一次独立的计费调用，它的 input 必须相加，
 * 否则会被静默丢掉。
 */
export function addOutOfBandUsage(
  turn: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return turn;
  const num = (u: Record<string, unknown> | undefined, ...keys: string[]) => {
    if (!u) return 0;
    for (const k of keys) {
      const v = Number(u[k]);
      if (Number.isFinite(v) && v !== 0) return v;
    }
    return 0;
  };
  return {
    ...(turn ?? {}),
    input_tokens:
      num(turn, "input_tokens", "prompt_tokens") +
      num(extra, "input_tokens", "prompt_tokens"),
    output_tokens:
      num(turn, "output_tokens", "completion_tokens") +
      num(extra, "output_tokens", "completion_tokens"),
    cache_read_input_tokens:
      num(turn, "cache_read_input_tokens", "prompt_cache_hit_tokens") +
      num(extra, "cache_read_input_tokens", "prompt_cache_hit_tokens"),
    cache_creation_input_tokens:
      num(turn, "cache_creation_input_tokens", "prompt_cache_miss_tokens") +
      num(extra, "cache_creation_input_tokens", "prompt_cache_miss_tokens"),
  };
}

function extractUserInputText(content: AgentRuntimeMessageContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (part?.type === "text" && part.text ? [part.text] : []))
    .join("\n")
    .trim();
}

function attachDialogIdToError(error: unknown, dialogId: string | undefined) {
  if (!dialogId) return;
  if (typeof error === "object" && error !== null) {
    (error as { dialogId?: string }).dialogId = dialogId;
  }
}

/**
 * Persist a failed/aborted turn so TUI can keep `state.dialogId` and the next
 * user message continues the same conversation instead of opening a fresh one.
 * If saveTurn itself fails, fall back to continueDialogId when present.
 */
async function persistFailedLocalTurn(args: {
  adapter: AgentRuntimeHostAdapter;
  agentKey: string;
  messages: AgentRuntimeChatMessage[];
  error: unknown;
  model?: string;
  toolCallCount?: number;
  partialContent?: string;
  input: LocalAgentTurnInput;
}): Promise<string | undefined> {
  const errorMessage = toErrorMessage(args.error);
  try {
    const saved = await args.adapter.saveTurn({
      agentKey: args.agentKey,
      messages: args.messages,
      result: {
        content:
          args.partialContent ||
          `[nolo] Agent run failed: ${errorMessage}`,
        model: args.model ?? "unknown",
        toolCallCount: args.toolCallCount ?? 0,
        error: true,
        errorMessage,
      },
      ...(args.input.runtimeContext
        ? { runtimeContext: args.input.runtimeContext }
        : {}),
      ...(args.input.continueDialogId
        ? { continueDialogId: args.input.continueDialogId }
        : {}),
      ...(args.input.spaceId ? { spaceId: args.input.spaceId } : {}),
      ...(args.input.category ? { category: args.input.category } : {}),
      ...(args.input.inheritedFromDialogKey
        ? { inheritedFromDialogKey: args.input.inheritedFromDialogKey }
        : {}),
      ...(args.input.parentDialogId
        ? { parentDialogId: args.input.parentDialogId }
        : {}),
    });
    return saved?.dialogId;
  } catch {
    return args.input.continueDialogId;
  }
}
function applyPersistedTurnInput(
  messages: AgentRuntimeChatMessage[],
  persistedInput: AgentRuntimeMessageContent | undefined,
  persistedInputReference: AgentRuntimeMessageContent | undefined,
): AgentRuntimeChatMessage[] {
  if (persistedInput === undefined && persistedInputReference === undefined) {
    return messages;
  }
  let replaced = false;
  return messages.map((message) => {
    if (replaced || message.role !== "user") return message;
    replaced = true;
    return {
      ...message,
      ...(persistedInput !== undefined ? { content: persistedInput } : {}),
      ...(persistedInputReference !== undefined
        ? { context_reference: persistedInputReference }
        : {}),
    };
  });
}

export async function runLocalAgentTurn(
  input: LocalAgentTurnInput
): Promise<LocalAgentTurnResult> {
  const agentConfig = await input.adapter.loadAgentConfig(input.agentRef);
  if (!agentConfig) {
    const error = new Error(`Local agent config not found: ${input.agentRef}`) as Error & {
      code?: string;
      agentRef?: string;
    };
    error.code = LOCAL_AGENT_CONFIG_MISSING_CODE;
    error.agentRef = input.agentRef;
    throw error;
  }

  let history: AgentRuntimeChatMessage[] = [];
  try {
    history = input.continueDialogId
      ? await input.adapter.loadDialogHistory(input.continueDialogId)
      : [];
  } catch (error) {
    // History load failed mid-continue: still park the user's message on the
    // existing dialog so the next "继续" keeps the same pointer.
    const dialogId = await persistFailedLocalTurn({
      adapter: input.adapter,
      agentKey: agentConfig.key,
      messages: [{ role: "user", content: input.input }],
      error,
      model: agentConfig.model,
      input,
    });
    attachDialogIdToError(error, dialogId);
    throw error;
  }
  // Identity block (名称/ID/模型/回复语言) — session-scope so it sits in the
  // stable prefix. Built from the resolved agentConfig so subscribed/custom
  // agents get their model name injected, matching the web and server paths
  // (previously the local/desktop/TUI runtime omitted the identity block).
  const identityBlock = buildIdentityBlock({
    agentName: agentConfig.name,
    agentId: agentConfig.key,
    model: agentConfig.model,
  });
  // 与 web/server 对齐：为本地宿主注入 runtime guidance 块（startup-protocol /
  // context-layer-contract / email-registration-workflow / web-research-tool-policy，
  // 仅保留非空块）与 current-time 块。guidance 块作为 session-scope（稳定前缀，
  // 利于 prefix cache），current-time 块作为 turn-scope（动态后缀）。
  // Guidance must describe the tools the model can actually call. Hosts that
  // drop undeliverable names report the survivors via exposedToolNames; fall
  // back to the declared list for hosts that expose everything they declare.
  const agentTools = canonicalizeToolNames(
    agentConfig.exposedToolNames ?? agentConfig.toolNames ?? []
  );
  const guidanceBlocks = buildRuntimeGuidanceBlocks(agentTools);
  const guidanceScopes: ContextBlockScope[] =
    [
      guidanceBlocks.startupProtocol,
      guidanceBlocks.contextLayerContract,
      guidanceBlocks.emailRegistrationWorkflow,
      guidanceBlocks.webResearchToolPolicy,
    ]
      .map((content) => content.trim())
      .filter((content): content is string => content.length > 0)
      .map((content) => ({ content, cacheScope: "session" as const }));
  const currentTimeScope: ContextBlockScope[] = [
    { content: buildCurrentTimeBlock(new Date(), undefined), cacheScope: "turn" as const },
  ];
  // Built-in scopes (identity/guidance/time) always come first; the caller's
  // normalized scopes follow. normalizeContextBlockScopes reconciles
  // input.contextBlockScopes (authoritative) with input.contextBlocks
  // (legacy plain strings → turn-scope) so a caller that only supplies
  // contextBlocks still gets its blocks included exactly once.
  const callerScopes = normalizeContextBlockScopes(
    input.contextBlocks,
    input.contextBlockScopes,
  );
  const mergedContextBlockScopes: ContextBlockScope[] = [
    { content: identityBlock, cacheScope: "session" as const },
    ...guidanceScopes,
    ...currentTimeScope,
    ...callerScopes,
  ];

  // Provider 惰性解析：自动压缩需要生成摘要时才 resolve；主循环复用同一实例。
  // resolve 失败由压缩路径吞掉（退回兜底裁剪），主循环再 resolve 时仍走原有 saveTurn 路径。
  let resolvedProvider: AgentRuntimeProvider | undefined;
  const resolveProviderOnce = async (): Promise<AgentRuntimeProvider> => {
    if (!resolvedProvider) {
      resolvedProvider = await input.adapter.resolveProvider(agentConfig);
    }
    return resolvedProvider;
  };

  // 自动上下文压缩：先于预算兜底。摘要持久化，压缩点之间前缀稳定以保住缓存。
  // 失败只记日志，绝不阻断本轮对话。
  // 摘要那次 LLM 调用是一次独立的计费调用，用量必须并入本轮 usage，
  // 否则只出现在 provider 账单上、我们自己的 token 记账看不到。
  let compactionUsage: Record<string, unknown> | undefined;
  try {
    const compacted = await maybeAutoCompactLocalHistory({
      adapter: input.adapter,
      dialogId: input.continueDialogId,
      history,
      model: agentConfig.model,
      resolveProvider: resolveProviderOnce,
    });
    history = compacted.history;
    compactionUsage = compacted.usage;
  } catch (error) {
    console.warn("[localLoop] auto-compaction unexpected error:", error);
  }

  // 上下文预算兜底：必须在 turnStartIndex 之前裁，否则该索引会指向错误位置。
  const trimmedHistory = trimHistoryToContextBudget(history, agentConfig.model);
  if (trimmedHistory.droppedCount > 0) {
    history = trimmedHistory.history;
  }

  const hasContextBlocks =
    callerScopes.some((block) => block.content.trim()) ||
    mergedContextBlockScopes.some((block) => block.content.trim());
  const promptMessageCount =
    agentConfig.prompt?.trim() || hasContextBlocks ? 1 : 0;
  const turnStartIndex = promptMessageCount + history.length;
  const builtMessages = buildMessages({
    prompt: agentConfig.prompt,
    contextBlockScopes: mergedContextBlockScopes,
    history,
    input: input.input,
    contextReferenceResolver:
      input.adapter.host === "cli" ? input.contextReferenceResolver : undefined,
  });
  const messages = builtMessages.messages;
  // vision 能力检测：catalog 已知模型按 hasVision 判定，未知模型默认 true。
  // 不支持图片时，buildMessages 产出的 image_url parts 必须在发给 provider 前剥离，
  // 否则上游 400 "this model does not support image input" → local 判失败 → fallback
  // 到没有 local code 工具的 server → agent 报 blocker。hasVision 字段类型不一定在
  // AgentRuntimeAgentConfig 上声明，用 as any 兜底。
  const supportsImages = resolveAgentImageInputSupport({
    apiSource: agentConfig.apiSource,
    provider: agentConfig.provider,
    model: agentConfig.model,
    hasVision: (agentConfig as any).hasVision,
  });
  const userInputText = extractUserInputText(input.input);
  let toolCallCount = 0;
  let result: AgentRuntimeResult;
  let turnUsage: Record<string, unknown> | undefined;
  let loopError: unknown;
  let round = 0;
  // 空轮修复状态（语义与 server loop 对齐）：
  //   repairPending  → 下一轮请求注入 repair system message
  //   repairUsed     → 已用过 repair，二次仍空则 fallback
  let emptyAssistantRepairPending = false;
  let emptyAssistantRepairUsed = false;
  // 首次图片降级通知标志——每轮可能都带图，但只通知一次，避免刷屏。
  let imageDowngradeNotified = false;
  // provider（如 Cursor）在流内执行完所有工具时，output blocks 已含全部
  // 文本块（含最后一段）。break 后跳过通用最终 assistant 消息追加。
  let skipFinalAppend = false;
  // 当前未完成轮的流式文本累加。每轮入口重置，只保留最新未完成轮的文本，
  // 供 loopError 分支在 saveTurn 时写入，避免中断时丢失已生成的部分回复。
  let partialContent = "";
  try {
    // resolveProvider used to sit outside the try: credential / provider-init
    // failures then skipped saveTurn, so TUI lost dialogId and the next
    // message opened a fresh conversation ("amnesia").
    // Auto-compaction may have already resolved the provider; reuse it.
    const provider = await resolveProviderOnce();
    while (true) {
      partialContent = "";
      throwIfAborted(input);
      // 空轮修复：把 repair user message 追加到本轮请求末尾重试一次（系统消息放在末尾会被大部分 Provider API 拒收或返回空消息）。
      const preparedMessages = prepareMessagesForProviderCall(messages);
      const baseRequestMessages = filterImagePartsFromMessages(
        preparedMessages.messages,
        supportsImages,
      );
      // 首次实际降级（模型不支持图片且本轮消息里确实含 image_url part）时通知一次，
      // 让 CLI 层写「推荐切到 vision agent」提示。不在 supportsImages===true 或无图时触发。
      if (
        !supportsImages &&
        !imageDowngradeNotified &&
        messages.some((m) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === "image_url"))
      ) {
        imageDowngradeNotified = true;
        emitLoopEvent(input, {
          kind: "image-downgraded",
          reason: "no-vision",
          atMs: Date.now(),
        });
      }
      const requestMessages: AgentRuntimeChatMessage[] = emptyAssistantRepairPending
        ? [...baseRequestMessages, { role: "user", content: EMPTY_ASSISTANT_REPAIR_PROMPT }]
        : baseRequestMessages;
      const contextMetrics: LocalAgentContextMetrics = {
        ...preparedMessages.metrics,
        messageCount: requestMessages.length,
        contentChars: requestMessages.reduce(
          (total, message) => total + contentCharCount(message.content),
          0,
        ),
        stableContextChars: builtMessages.stableContextChars,
        dynamicContextChars: builtMessages.dynamicContextChars,
      };
      emptyAssistantRepairPending = false;
      result = await runCompleteWithTimeout({
        provider,
        messages: requestMessages,
        options: {
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.onTextDelta ? { onTextDelta: (chunk: string) => {
            partialContent += chunk;
            input.onTextDelta!(chunk);
          } } : {}),
          ...(input.onReasoningDelta ? { onReasoningDelta: input.onReasoningDelta } : {}),
          ...(input.onToolEvent ? { onToolEvent: input.onToolEvent } : {}),
          ...(input.onToolEvent ? { toolEventRound: round } : {}),
        },
        timeoutMs: resolveLlmRequestTimeoutMs(input),
        round,
        input,
        context: contextMetrics,
      });
      turnUsage = mergeTurnUsage(turnUsage, result.usage);
      const toolCalls = result.tool_calls ?? [];
      const rawToolCallsCount = (result.tool_calls?.length ?? 0) || (Array.isArray((result as any).raw_tool_calls) ? (result as any).raw_tool_calls.length : 0);
      if (toolCalls.length === 0 && rawToolCallsCount === 0) {
        // 空轮判定：无可见输出（文本/图片）且绝对无 tool_calls 意图即空轮。
        // reasoning_content 不算可见输出（见 hasAssistantVisibleOutput 注释），
        // reasoning-only 仍按空轮处理，走 repair/fallback。
        const outcome = resolveEmptyAssistantOutcome({
          hasToolCalls: rawToolCallsCount > 0,
          hasVisibleOutput: hasAssistantVisibleOutput(result.content),
          repairUsed: emptyAssistantRepairUsed,
          finishReason: result.finish_reason,
          streamComplete: result.stream_complete,
        });
        if (outcome.kind === "repair") {
          emptyAssistantRepairPending = true;
          emptyAssistantRepairUsed = true;
          continue;
        }
        if (outcome.kind === "fallback") {
          // 二次仍空：按成因选诊断文案作为最终 content 结束，不抛错
          // （行为与 server loop 对齐——两边共用同一个映射函数）。
          result = {
            ...result,
            content: resolveEmptyAssistantFallbackMessage(outcome.reason),
          };
          break;
        }
        break;
      }
      // ── Canonical output blocks：provider（如 Cursor）返回有序 block 序列时，
      // 按 block 消费。toolCall block 的 result 已填充 = 流内已执行，不跑 executeTool。
      // 有带 result 的 toolCall 时 skipFinalAppend（文本已由 onTextDelta 推完）。
      const outputBlocks: AgentRuntimeOutputBlock[] = result.output ?? [];
      if (outputBlocks.length > 0) {
        let hasInlineExecutedTools = false;
        for (const block of outputBlocks) {
          if (block.type !== "toolCall") continue;
          toolCallCount += 1;
          const toolName = block.toolCall.function.name;
          if (block.result) {
            hasInlineExecutedTools = true;
            // Provider 已经在流内通过 onToolEvent 发过 tool-call / tool-result
            // （见 cursorProvider.handleExecServerMessage）。这里不再补发，避免
            // CLI/Desktop 收到重复事件、工具卡片错位。loop 事件同理不再补。
            // 仍递增 toolCallCount 以反映本轮工具调用数。
          } else {
            // block 无 result = provider 未流内执行。
            // 当前没有任何 provider 走到这里（Cursor 所有 toolCall 都带 result）。
            // 拒绝继续而不是悄悄跑 executeTool 后丢上下文：未流内执行的 output
            // block 在标准 tool 循环里没有对应 messages，下一轮发给 provider 会
            // 丢历史。让调用方显式报 bug，而不是把工具结果悄悄塞进 block 里
            // 当没发生。
            throw new Error(
              `provider returned output block with unexecuted toolCall "${toolName}" (id=${block.toolCall.id}); ` +
              "no provider currently emits this shape. Either the provider must fill block.result " +
              "(like Cursor's exec channel) or it must not set result.output at all.",
            );
          }
        }
        if (hasInlineExecutedTools) {
          messages.push(...blocksToOpenAiMessages(outputBlocks));
          skipFinalAppend = true;
          break;
        }
        round += 1;
        continue;
      }
      toolCallCount += toolCalls.length;
      messages.push({
        role: "assistant",
        content: result.content || null,
        ...(result.reasoning_content ? { reasoning_content: result.reasoning_content } : {}),
        tool_calls: toolCalls,
      });
      for (const toolCall of toolCalls) {
        throwIfAborted(input);
        const toolName = toolCall.function.name;
        let toolResult;
        const startedAt = Date.now();
        emitLoopEvent(input, { kind: "tool-start", name: toolName, atMs: Date.now() });
        emitToolEvent(input, {
          type: "tool-call",
          round,
          toolCallId: toolCall.id,
          toolName,
          argumentsPreview: summarizeToolArguments(toolName, toolCall.function.arguments),
        });
        try {
          const executePromise = input.adapter.executeTool({
            id: toolCall.id,
            name: toolName,
            arguments: toolCall.function.arguments,
            ...(userInputText ? { userInput: userInputText } : {}),
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
          });
          toolResult = await raceWithAbort(input, executePromise, toolName);
          const actionGate = buildActionGate({
            toolName,
            toolCallId: toolCall.id,
            metadata: toolResult.metadata,
          });
          if (actionGate && input.onActionGate) {
            const replacement = await input.onActionGate(actionGate);
            if (replacement) {
              toolResult = replacement;
            }
          }
          emitLoopEvent(input, { kind: "tool-end", name: toolName, atMs: Date.now(), ok: true });
          emitToolEvent(input, {
            type: "tool-result",
            round,
            toolCallId: toolCall.id,
            toolName,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            summary: summarizeToolResult(toolResult.content, toolResult.metadata),
            ...(typeof toolResult.content === "string"
              ? { content: toolResult.content }
              : {}),
            metadata: toolResult.metadata,
          });
        } catch (error) {
          emitLoopEvent(input, { kind: "tool-end", name: toolName, atMs: Date.now(), ok: false });
          // abort 优先：race 赢后必须原样上抛（error 上带 pendingToolName），
          // 不能被 shouldReturnToolExecutionErrors 转成 tool result 吞掉。
          if (
            error &&
            typeof error === "object" &&
            (error as { code?: unknown }).code === LOCAL_TURN_ABORTED_CODE
          ) {
            throw error;
          }
          if (!shouldReturnToolExecutionErrors(input.adapter)) throw error;
          emitToolEvent(input, {
            type: "tool-error",
            round,
            toolCallId: toolCall.id,
            toolName,
            elapsedMs: Math.max(0, Date.now() - startedAt),
            message: toErrorMessage(error),
          });
          toolResult = {
            content:
              formatStructuredToolExecutionError({ toolName, error }) ??
              formatToolExecutionError({ toolName, error }),
            metadata: {
              error: true,
              toolName,
              message: toErrorMessage(error),
              ...(
                error &&
                typeof error === "object" &&
                typeof (error as { code?: unknown }).code === "string"
                  ? { code: (error as { code: string }).code }
                  : {}
              ),
            },
          };
        }
        messages.push({
          role: "tool",
          content: formatToolMessageContent({
            toolName,
            content: toolResult.content,
            metadata: toolResult.metadata,
          }),
          tool_call_id: toolCall.id,
          toolName,
          ...(toolResult.metadata ? { tool_result_metadata: toolResult.metadata } : {}),
        });
      }
      round += 1;
    }
  } catch (error) {
    loopError = error;
  }

  // 即使 provider 循环失败（超时/额度/凭证等），也保存 dialog 以便续聊与复盘
  if (loopError) {
    const turnMessages = applyPersistedTurnInput(
      messages.slice(turnStartIndex),
      input.persistedInput,
      input.persistedInputReference,
    );
    const dialogId = await persistFailedLocalTurn({
      adapter: input.adapter,
      agentKey: agentConfig.key,
      messages: turnMessages,
      error: loopError,
      model: agentConfig.model,
      toolCallCount,
      partialContent,
      input,
    });
    attachDialogIdToError(loopError, dialogId);
    throw loopError;
  }

  result = result!;
  if (!skipFinalAppend) {
    messages.push({
      role: "assistant",
      content: result.content,
      // 与中间轮(:561)一致带上 reasoning_content,让 saveTurn 持久化思维链,
      // 空轮/异常排查时能回看模型实际想了什么。
      ...(result.reasoning_content
        ? { reasoning_content: result.reasoning_content }
        : {}),
    });
  }
  const turnMessages = applyPersistedTurnInput(
    messages.slice(turnStartIndex),
    input.persistedInput,
    input.persistedInputReference,
  );
  const saved = await input.adapter.saveTurn({
    agentKey: agentConfig.key,
    messages: turnMessages,
    result: {
      ...result,
      ...(toolCallCount > 0 ? { toolCallCount } : {}),
      ...((agentConfig as any).toolSurface ? { runtimeToolSurface: (agentConfig as any).toolSurface } : {}),
    },
    ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
    ...(input.continueDialogId ? { continueDialogId: input.continueDialogId } : {}),
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    ...(input.category ? { category: input.category } : {}),
    ...(input.inheritedFromDialogKey ? { inheritedFromDialogKey: input.inheritedFromDialogKey } : {}),
    ...(input.parentDialogId ? { parentDialogId: input.parentDialogId } : {}),
  });

  return {
    ...result,
    ...((() => {
      const merged = addOutOfBandUsage(turnUsage, compactionUsage);
      return merged ? { usage: merged } : {};
    })()),
    ...(toolCallCount > 0 ? { toolCallCount } : {}),
    ...((agentConfig as any).toolSurface ? { runtimeToolSurface: (agentConfig as any).toolSurface } : {}),
    // 透出最后一轮 provider 调用的 finish_reason；多轮工具循环里只有最后一轮收尾状态有意义。
    ...(result.finish_reason ? { finish_reason: result.finish_reason } : {}),
    dialogId: saved.dialogId,
    turnMessages,
  };
}
