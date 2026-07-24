import { clipCompactText } from "../core/clipCompactText";
import { compactWhitespace } from "../core/compactWhitespace";
import { toErrorMessage } from "../core/errorMessage";
import { asOptionalTrimmedString } from "../core/optionalString";

import type {
  AgentRuntimeHostAdapter,
  AgentRuntimeToolResult,
} from "./hostAdapter";
import type { ActionGate } from "./actionGate";
import { readActionGate, readCommandActionGatePayload } from "./actionGate";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeMessageContent,
  AgentRuntimeResult,
} from "./types";
import { parseToolArgumentsJson } from "./parseToolArguments";

export type LocalAgentTurnInput = {
  adapter: AgentRuntimeHostAdapter;
  agentRef: string;
  input: AgentRuntimeMessageContent;
  continueDialogId?: string;
  spaceId?: string;
  /**
   * Runtime-assembled context blocks (space/workspace layers from
   * turnContext.ts). Appended after the agent prompt inside the same
   * system message so every host surface shares identical semantics.
   */
  contextBlocks?: string[];
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

export type LocalAgentLoopEvent =
  | { kind: "llm-start"; round: number; atMs: number }
  | { kind: "llm-end"; round: number; atMs: number; ok: boolean }
  | { kind: "tool-start"; name: string; atMs: number }
  | { kind: "tool-end"; name: string; atMs: number; ok: boolean };

export type LocalAgentActionGate = ActionGate & {
  toolName: string;
  toolCallId: string;
};

export const LOCAL_AGENT_CONFIG_MISSING_CODE = "LOCAL_AGENT_CONFIG_MISSING";

/**
 * 空轮修复共享常量。
 *
 * 这两个文案常量与判定语义由 `packages/server/handlers/agentRun/loop.ts`
 * 的空轮处置流程首次落地，现下沉到 agent-runtime 共享层，使 CLI local 与
 * 桌面 local turn（都消费 `runLocalAgentTurn`）与服务端 loop 行为一致。
 * 服务端 loop 通过 `../../../agent-runtime` 引用同一常量，仅替换常量来源，
 * 不动其判定/流程逻辑。
 */
export const EMPTY_ASSISTANT_REPAIR_PROMPT =
  "你刚刚返回了空消息。请继续完成当前任务：如果需要工具就调用工具，否则直接输出可执行的简短结果；不要留空。";
export const EMPTY_ASSISTANT_FALLBACK_MESSAGE =
  "模型连续返回空消息，当前任务未完成。请重试当前步骤，或给出更具体的修改范围。";

/**
 * 判定空 assistant 回复的处置方式。语义与 server loop 完全一致：
 *
 * - 有 tool calls 或可见输出（文本/图片等） → ok
 * - 未用过 repair → repair（注入 repair system message 重试一次）
 * - 用过 repair → fallback/empty_completion（以诊断文案结束）
 *
 * reasoning-only 流（content 空、无 tool_calls）算空轮，无论 reasoning 有无。
 */
export function resolveEmptyAssistantOutcome(args: {
  hasToolCalls: boolean;
  hasVisibleOutput: boolean;
  repairUsed: boolean;
}): { kind: "ok" } | { kind: "repair" } | { kind: "fallback"; reason: "empty_completion" } {
  if (args.hasToolCalls || args.hasVisibleOutput) return { kind: "ok" };
  if (!args.repairUsed) return { kind: "repair" };
  return { kind: "fallback", reason: "empty_completion" };
}

/** assistant 是否产生了可见输出（文本/图片）。tool_calls 由调用方单独判定。 */
export function hasAssistantVisibleOutput(content: AgentRuntimeMessageContent): boolean {
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
}): Promise<AgentRuntimeResult> {
  const { provider, messages, options, timeoutMs, round, input } = args;

  emitLoopEvent(input, { kind: "llm-start", round, atMs: Date.now() });
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

  try {
    const result =
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
    emitLoopEvent(input, { kind: "llm-end", round, atMs: Date.now(), ok });
  }
}

function clip(value: string, max = 240) {
  return clipCompactText(value, max);
}


function summarizeToolArguments(toolName: string, rawArgs: string | undefined) {
  const args = parseToolArgumentsJson(rawArgs);
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = asOptionalTrimmedString(args[key]);
      if (value) return value;
    }
    return "";
  };
  const command = pick("command", "cmd", "runCommand", "executeCommand", "bash");
  if (command) return clip(command);
  const filePath = pick("filePath", "file_path", "path", "filename", "file");
  if (filePath) return clip(filePath);
  const query = pick("query", "pattern", "search", "q");
  if (query) return clip(query);
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  return clip(keys.slice(0, 6).map((key) => {
    const value = args[key];
    if (typeof value === "string") return `${key}=${clip(value, 80)}`;
    if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;
    if (Array.isArray(value)) return `${key}[${value.length}]`;
    return `${key}=${value === null ? "null" : typeof value}`;
  }).join(" "));
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

const MAX_HISTORICAL_TOOL_CONTENT_CHARS = 2400;
// Aligns with server read_file upstream compaction so multi-round tool loops do
// not resend huge tool payloads on every LLM call within the same turn.
const MAX_IN_TURN_TOOL_CONTENT_CHARS = 6000;

function summarizeToolContentForProvider(
  content: AgentRuntimeMessageContent,
  maxChars: number,
  label: string,
): AgentRuntimeMessageContent {
  if (typeof content !== "string") return content;
  if (content.length <= maxChars) return content;

  const compact = compactWhitespace(content);
  const clipped = compact.length > maxChars
    ? compact.slice(0, maxChars - 160)
    : compact;
  return [
    `[${label}]`,
    `originalChars=${content.length}`,
    clipped,
  ].join("\n");
}

function summarizeHistoricalToolContent(content: AgentRuntimeMessageContent): AgentRuntimeMessageContent {
  return summarizeToolContentForProvider(
    content,
    MAX_HISTORICAL_TOOL_CONTENT_CHARS,
    "historical tool result truncated for the next turn",
  );
}

function prepareMessagesForProviderCall(
  messages: AgentRuntimeChatMessage[],
): AgentRuntimeChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: summarizeToolContentForProvider(
        message.content,
        MAX_IN_TURN_TOOL_CONTENT_CHARS,
        "in-turn tool result truncated before next provider call",
      ),
    };
  });
}

function prepareHistoryForNextTurn(history: AgentRuntimeChatMessage[]): AgentRuntimeChatMessage[] {
  return history.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: summarizeHistoricalToolContent(message.content),
    };
  });
}

function buildMessages(args: {
  prompt?: string;
  contextBlocks?: string[];
  history: AgentRuntimeChatMessage[];
  input: AgentRuntimeMessageContent;
}): AgentRuntimeChatMessage[] {
  const blocks = (args.contextBlocks ?? [])
    .map((block) => block.trim())
    .filter(Boolean);
  const systemContent = [args.prompt?.trim(), ...blocks]
    .filter(Boolean)
    .join("\n\n");
  return [
    ...(systemContent
      ? [{ role: "system" as const, content: systemContent }]
      : []),
    ...prepareHistoryForNextTurn(args.history),
    { role: "user" as const, content: args.input },
  ];
}

function mergeTurnUsage(
  current: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined
) {
  if (!next) return current;
  const read = (usage: Record<string, unknown>) => ({
    input: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0),
    output: Number(usage.output_tokens ?? usage.completion_tokens ?? 0),
  });
  const right = read(next);
  const left = current ? read(current) : { input: 0, output: 0 };
  return {
    input_tokens: right.input || left.input,
    output_tokens: left.output + right.output,
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

  const history = input.continueDialogId
    ? await input.adapter.loadDialogHistory(input.continueDialogId)
    : [];
  const hasContextBlocks = (input.contextBlocks ?? []).some((block) =>
    block.trim()
  );
  const promptMessageCount =
    agentConfig.prompt?.trim() || hasContextBlocks ? 1 : 0;
  const turnStartIndex = promptMessageCount + history.length;
  const messages = buildMessages({
    prompt: agentConfig.prompt,
    contextBlocks: input.contextBlocks,
    history,
    input: input.input,
  });
  const provider = await input.adapter.resolveProvider(agentConfig);
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
  try {
    while (true) {
      throwIfAborted(input);
      // 空轮修复：把 repair system message 追加到本轮请求末尾重试一次。
      const baseRequestMessages = prepareMessagesForProviderCall(messages);
      const requestMessages: AgentRuntimeChatMessage[] = emptyAssistantRepairPending
        ? [...baseRequestMessages, { role: "system", content: EMPTY_ASSISTANT_REPAIR_PROMPT }]
        : baseRequestMessages;
      emptyAssistantRepairPending = false;
      result = await runCompleteWithTimeout({
        provider,
        messages: requestMessages,
        options: {
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
          ...(input.onReasoningDelta ? { onReasoningDelta: input.onReasoningDelta } : {}),
        },
        timeoutMs: resolveLlmRequestTimeoutMs(input),
        round,
        input,
      });
      turnUsage = mergeTurnUsage(turnUsage, result.usage);
      const toolCalls = result.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // 空轮判定：content 空、无 tool_calls 即空轮（reasoning-only 也算空轮）。
        const outcome = resolveEmptyAssistantOutcome({
          hasToolCalls: false,
          hasVisibleOutput: hasAssistantVisibleOutput(result.content),
          repairUsed: emptyAssistantRepairUsed,
        });
        if (outcome.kind === "repair") {
          emptyAssistantRepairPending = true;
          emptyAssistantRepairUsed = true;
          continue;
        }
        if (outcome.kind === "fallback") {
          // 二次仍空：以诊断文案作为最终 content 结束，不抛错（行为与 server loop 对齐）。
          result = { ...result, content: EMPTY_ASSISTANT_FALLBACK_MESSAGE };
          break;
        }
        break;
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
          toolResult = await input.adapter.executeTool({
            id: toolCall.id,
            name: toolName,
            arguments: toolCall.function.arguments,
            ...(userInputText ? { userInput: userInputText } : {}),
          });
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
          ...(toolResult.metadata ? { tool_result_metadata: toolResult.metadata } : {}),
        });
      }
      round += 1;
    }
  } catch (error) {
    loopError = error;
  }

  // 即使 provider 循环失败（超时等），也保存 dialog 以便复盘
  if (loopError) {
    const errorMessage = toErrorMessage(loopError);
    const turnMessages = messages.slice(turnStartIndex);
    await input.adapter.saveTurn({
      agentKey: agentConfig.key,
      messages: turnMessages,
      result: {
        content: `[nolo] Agent run failed: ${errorMessage}`,
        model: agentConfig.model ?? "unknown",
        toolCallCount,
        error: true,
        errorMessage,
      },
      ...(input.runtimeContext ? { runtimeContext: input.runtimeContext } : {}),
      ...(input.continueDialogId ? { continueDialogId: input.continueDialogId } : {}),
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.inheritedFromDialogKey ? { inheritedFromDialogKey: input.inheritedFromDialogKey } : {}),
      ...(input.parentDialogId ? { parentDialogId: input.parentDialogId } : {}),
    });
    throw loopError;
  }

  result = result!;
  messages.push({
    role: "assistant",
    content: result.content,
    // 与中间轮(:561)一致带上 reasoning_content,让 saveTurn 持久化思维链,
    // 空轮/异常排查时能回看模型实际想了什么。
    ...(result.reasoning_content
      ? { reasoning_content: result.reasoning_content }
      : {}),
  });
  const turnMessages = messages.slice(turnStartIndex);
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
    ...(turnUsage ? { usage: turnUsage } : {}),
    ...(toolCallCount > 0 ? { toolCallCount } : {}),
    ...((agentConfig as any).toolSurface ? { runtimeToolSurface: (agentConfig as any).toolSurface } : {}),
    dialogId: saved.dialogId,
    turnMessages,
  };
}
