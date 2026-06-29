// packages/integrations/openai/filterAndCleanMessages.ts

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: ToolCallFunction;
}

export interface OpenAIMessage {
  id?: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string | MessagePart[];
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface InternalMessage extends Omit<Partial<OpenAIMessage>, "content"> {
  role: OpenAIMessage["role"];
  content?: unknown;
  toolName?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolPayload?: {
    toolName?: string;
    rawToolCall?: ToolCall & { id: string };
  };
  [key: string]: any;
}

const TOOL_CONTEXT_MAX_CHARS = 4000;

const truncateText = (text: string, maxChars: number = TOOL_CONTEXT_MAX_CHARS): string => {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[截断，原始长度 ${text.length} 字符]`;
};

export const isValidMessagePart = (part: any): part is MessagePart => {
  if (!part || typeof part !== "object") return false;
  if (part.type === "text") return typeof part.text === "string";
  if (part.type === "image_url") {
    const img = part.image_url;
    return img && typeof img === "object" && typeof img.url === "string" && img.url.length > 0;
  }
  return false;
};

const extractContent = (msg: InternalMessage): string | MessagePart[] | null => {
  if (msg.role === "tool") {
    const llmContext = typeof msg.toolPayload?.llmContext === "string"
      ? msg.toolPayload.llmContext.trim()
      : "";
    if (llmContext) return truncateText(llmContext);

    const summary = typeof msg.toolPayload?.summary === "string"
      ? msg.toolPayload.summary.trim()
      : "";
    if (summary) return truncateText(summary);

    if (typeof msg.content === "string") return truncateText(msg.content);
    if (msg.content != null) return truncateText(JSON.stringify(msg.content));
    return null;
  }

  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    const parts = msg.content.filter(isValidMessagePart);
    return parts.length > 0 ? parts : null;
  }
  if (msg.content && typeof msg.content === "object" && isValidMessagePart(msg.content)) {
    return [msg.content as MessagePart];
  }
  return null;
};

const extractToolCalls = (msg: InternalMessage): ToolCall[] | undefined => {
  const calls = msg.tool_calls ?? msg.toolCalls;
  return Array.isArray(calls) && calls.length > 0 ? calls : undefined;
};

const extractToolCallId = (msg: InternalMessage): string | undefined =>
  msg.tool_call_id ?? msg.toolCallId ?? msg.toolPayload?.rawToolCall?.id;

const extractName = (msg: InternalMessage): string | undefined => {
  if (typeof msg.name === "string") return msg.name;
  if (typeof msg.toolName === "string") return msg.toolName;
  if (typeof msg.toolPayload?.toolName === "string") return msg.toolPayload.toolName;
  return undefined;
};

const getToolName = (msg: any): string | undefined =>
  msg?.toolName ?? msg?.toolPayload?.toolName;

const parseJsonObject = (value: unknown): Record<string, any> | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

const isHandoffToolMessage = (msg: any): boolean => {
  const toolName = getToolName(msg);
  return toolName === "runStreamingAgent";
};

const getToolMessageCallId = (msg: any): string | undefined =>
  msg?.tool_call_id ?? msg?.toolCallId ?? msg?.toolPayload?.rawToolCall?.id;

const collectHandoffToolCallIds = (msgs: any[]): Set<string> => {
  const ids = new Set<string>();
  for (const msg of msgs) {
    if (msg?.role !== "tool" || !isHandoffToolMessage(msg)) continue;
    const id = getToolMessageCallId(msg);
    if (id) ids.add(id);
  }
  return ids;
};

const stripHandoffToolMessage = (msg: any): any | null =>
  msg?.role === "tool" && isHandoffToolMessage(msg) ? null : msg;

const removeToolCallsById = (calls: any[] | undefined, ids: Set<string>) =>
  calls?.filter((call) => !ids.has(call.id));

const stripHandoffToolCallsFromAssistant = (msg: any, handoffIds: Set<string>): any => {
  if (msg?.role !== "assistant") return msg;

  const calls: any[] | undefined = msg.tool_calls ?? msg.toolCalls;
  if (!calls?.some((call) => handoffIds.has(call.id))) return msg;

  const kept = removeToolCallsById(calls, handoffIds);
  return {
    ...msg,
    tool_calls: kept?.length ? kept : undefined,
    toolCalls: kept?.length ? kept : undefined,
  };
};

export const stripHandoffToolMessages = (msgs: any[]): any[] => {
  const handoffIds = collectHandoffToolCallIds(msgs);
  if (handoffIds.size === 0) return msgs;

  return msgs
    .map(stripHandoffToolMessage)
    .filter(Boolean)
    .map((msg) => stripHandoffToolCallsFromAssistant(msg, handoffIds));
};

const toOpenAIMessage = (rawMsg: any): OpenAIMessage | null => {
  const msg = rawMsg as InternalMessage;
  const { role, id } = msg;

  if (!role || !["system", "user", "assistant", "tool"].includes(role)) return null;

  const toolCalls = extractToolCalls(msg);
  let content = extractContent(msg);

  // assistant with tool_calls 允许 content 为空
  if (content === null) {
    if (role === "assistant" && toolCalls) content = "";
    else return null;
  }

  const cleaned: OpenAIMessage = { role, content };

  if (id) cleaned.id = id;
  const name = extractName(msg);
  if (name) cleaned.name = name;

  if (role === "assistant" && toolCalls) {
    cleaned.tool_calls = toolCalls;
  }

  if (role === "tool") {
    const toolCallId = extractToolCallId(msg);
    if (toolCallId) cleaned.tool_call_id = toolCallId;
    if (!cleaned.tool_call_id) {
      console.warn("[filterAndCleanMessages] 丢弃无效 tool 消息：缺少 tool_call_id", msg);
      return null;
    }
  }

  return cleaned;
};

/**
 * 清除孤立的 tool_result / assistant stub 对。
 *
 * 一条 tool 消息若在其前面最近的 assistant 消息的 tool_calls 中找不到对应 id，
 * 则视为孤立——连同对应的空 assistant stub 一起丢弃。
 */
const removeOrphanedToolPairs = (msgs: OpenAIMessage[]): OpenAIMessage[] => {
  const dropIndexes = new Set<number>();

  // 为每条 tool 消息找到对应的 assistant 索引
  const toolToAssistant = new Map<number, number>();
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "tool") continue;
    for (let j = i - 1; j >= 0; j--) {
      if (msgs[j].role === "assistant") {
        toolToAssistant.set(i, j);
        break;
      }
    }
  }

  // 标记孤立的 tool 消息
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "tool" && !toolToAssistant.has(i)) {
      dropIndexes.add(i);
      console.warn("[filterAndCleanMessages] 丢弃孤立 tool 消息：缺少前置 assistant", msgs[i].tool_call_id);
    }
  }

  for (const [toolIdx, assistantIdx] of toolToAssistant) {
    const toolMsg = msgs[toolIdx];
    if (!toolMsg.tool_call_id) continue;

    const knownIds = new Set((msgs[assistantIdx].tool_calls ?? []).map((tc) => tc.id));
    if (!knownIds.has(toolMsg.tool_call_id)) {
      dropIndexes.add(toolIdx);
      console.warn("[filterAndCleanMessages] 丢弃孤立 tool 消息:", toolMsg.tool_call_id);
    }
  }

  // 检查 assistant stub：若其所有 tool_calls 都已被孤立且自身无文本，一并丢弃
  for (const assistantIdx of new Set(toolToAssistant.values())) {
    if (dropIndexes.has(assistantIdx)) continue;

    const stub = msgs[assistantIdx];
    const content = typeof stub.content === "string" ? stub.content.trim() : stub.content;
    const isEmpty = content === "" || (Array.isArray(content) && content.length === 0);
    if (!isEmpty) continue;

    const allToolsDropped = (stub.tool_calls ?? []).every((tc) => {
      // 找所有引用该 id 的 tool 消息，看是否全被 drop
      return msgs.every((m, idx) =>
        m.role !== "tool" || m.tool_call_id !== tc.id || dropIndexes.has(idx)
      );
    });

    if (allToolsDropped) {
      dropIndexes.add(assistantIdx);
      console.warn("[filterAndCleanMessages] 一并丢弃孤立 assistant stub（index:", assistantIdx, ")");
    }
  }

  if (dropIndexes.size === 0) return msgs;
  return msgs.filter((_, idx) => !dropIndexes.has(idx));
};

/**
 * 将内部消息数组清洗为严格的 OpenAIMessage[]。
 *
 * 调用顺序建议：
 *   selectAllMsgs → buildAgentViewMessages → filterAndCleanMessages → generateRequestBody
 */
export const filterAndCleanMessages = (msgs: any[]): OpenAIMessage[] => {
  if (!Array.isArray(msgs)) return [];

  const flat = msgs.flat();
  const preprocessed = stripHandoffToolMessages(flat);
  const cleaned = preprocessed.map(toOpenAIMessage).filter((m): m is OpenAIMessage => m !== null);
  return removeOrphanedToolPairs(cleaned);
};
