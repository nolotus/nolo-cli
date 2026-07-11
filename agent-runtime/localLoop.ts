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

export type LocalAgentTurnInput = {
  adapter: AgentRuntimeHostAdapter;
  agentRef: string;
  input: AgentRuntimeMessageContent;
  continueDialogId?: string;
  spaceId?: string;
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
  onLoopEvent?: (event: LocalAgentLoopEvent) => void;
  /** 单次 provider.complete 的硬超时；默认 120_000ms。超时重试一次，再超时抛错结束回合。 */
  llmRequestTimeoutMs?: number;
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

function formatToolExecutionError(args: {
  toolName: string;
  error: unknown;
}) {
  const message = args.error instanceof Error ? args.error.message : String(args.error);
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

const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

function emitLoopEvent(input: LocalAgentTurnInput, event: LocalAgentLoopEvent) {
  if (!input.onLoopEvent) return;
  try {
    input.onLoopEvent(event);
  } catch {
    // 观测方回调异常必须被吞掉，不允许影响 loop 正确性
  }
}

const LLM_TIMEOUT_RETRY_EXHAUSTED = "LLM_TIMEOUT_RETRY_EXHAUSTED";

async function runCompleteWithTimeout(args: {
  provider: { complete(messages: AgentRuntimeChatMessage[], options?: any): Promise<AgentRuntimeResult> };
  messages: AgentRuntimeChatMessage[];
  options: Record<string, unknown>;
  timeoutMs: number;
  round: number;
  input: LocalAgentTurnInput;
}): Promise<AgentRuntimeResult> {
  const { provider, messages, options, timeoutMs, round, input } = args;

  const attempt = async (): Promise<AgentRuntimeResult> => {
    emitLoopEvent(input, { kind: "llm-start", round, atMs: Date.now() });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutReject = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`__llm_timeout__:${timeoutMs}`));
      }, timeoutMs);
    });
    const complete = provider.complete(messages, options);
    let ok = false;
    try {
      const result = await Promise.race([complete, timeoutReject]);
      ok = true;
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      emitLoopEvent(input, { kind: "llm-end", round, atMs: Date.now(), ok });
    }
  };

  try {
    return await attempt();
  } catch (error) {
    const isTimeout =
      error instanceof Error && error.message.startsWith("__llm_timeout__:");
    if (!isTimeout) throw error;
    // 第一次超时 → 重试一次（发新的 llm-start/llm-end）
    try {
      return await attempt();
    } catch (retryError) {
      const retryIsTimeout =
        retryError instanceof Error &&
        retryError.message.startsWith("__llm_timeout__:");
      if (!retryIsTimeout) throw retryError;
      const exhausted = new Error(
        `LLM request timed out after ${timeoutMs}ms (round ${round}, retry exhausted)`,
      ) as Error & { code?: string };
      exhausted.code = LLM_TIMEOUT_RETRY_EXHAUSTED;
      throw exhausted;
    }
  }
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, max = 240) {
  const compact = compactWhitespace(value);
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function parseToolArguments(raw: string | undefined) {
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function summarizeToolArguments(toolName: string, rawArgs: string | undefined) {
  const args = parseToolArguments(rawArgs);
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
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
  history: AgentRuntimeChatMessage[];
  input: AgentRuntimeMessageContent;
}): AgentRuntimeChatMessage[] {
  const systemContent = args.prompt?.trim();
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
  const promptMessageCount = agentConfig.prompt?.trim() ? 1 : 0;
  const turnStartIndex = promptMessageCount + history.length;
  const messages = buildMessages({
    prompt: agentConfig.prompt,
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
  try {
    while (true) {
      result = await runCompleteWithTimeout({
        provider,
        messages: prepareMessagesForProviderCall(messages),
        options: {
          ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
          ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
        },
        timeoutMs: input.llmRequestTimeoutMs ?? DEFAULT_LLM_REQUEST_TIMEOUT_MS,
        round,
        input,
      });
      turnUsage = mergeTurnUsage(turnUsage, result.usage);
      const toolCalls = result.tool_calls ?? [];
      if (toolCalls.length === 0) break;
      toolCallCount += toolCalls.length;
      messages.push({
        role: "assistant",
        content: result.content || null,
        ...(result.reasoning_content ? { reasoning_content: result.reasoning_content } : {}),
        tool_calls: toolCalls,
      });
      for (const toolCall of toolCalls) {
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
            message: error instanceof Error ? error.message : String(error),
          });
          toolResult = {
            content:
              formatStructuredToolExecutionError({ toolName, error }) ??
              formatToolExecutionError({ toolName, error }),
            metadata: {
              error: true,
              toolName,
              message: error instanceof Error ? error.message : String(error),
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
    const errorMessage = loopError instanceof Error ? loopError.message : String(loopError);
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
