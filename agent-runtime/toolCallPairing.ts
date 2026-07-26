/**
 * Tool-call / tool-result 配对护栏。
 *
 * 纯函数：Redux-free、无 I/O、无依赖注入，参考同目录其他纯模块的注释风格。
 *
 * 背景：对话历史可能被写坏成非法顺序——孤儿 tool 消息（前面没有 assistant
 * 声明该 tool_call_id）或悬空 tool_calls（assistant 声明了 id 但后面没有对应
 * tool 结果）。原样发给 OpenAI 兼容接口会触发 400 或让模型连续返回空 content。
 *
 * 本函数在发给 provider 之前做单次遍历 + 重排，保证输出满足 OpenAI 兼容接口的
 * 配对契约：每条带 `tool_calls` 的 assistant 消息后面**紧接着**必须出现它声明
 * 的每个 id 对应的 tool 结果；孤儿 tool 与悬空 tool_calls 都被剔除。
 *
 * 输入已合法时返回语义等价的结果（等价即可，不要求同一引用）。
 */

type AnyMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: Array<{ id?: string }>;
  tool_call_id?: string;
  toolCallId?: string;
};

/** 读取 tool 消息的 call id，兼容 `tool_call_id` 与驼峰 `toolCallId` 两种写法。 */
function readToolCallId(message: AnyMessage): string | undefined {
  if (typeof message.tool_call_id === "string" && message.tool_call_id) {
    return message.tool_call_id;
  }
  if (typeof message.toolCallId === "string" && message.toolCallId) {
    return message.toolCallId;
  }
  return undefined;
}

/** 判定 content 是否为空/仅空白（用于决定空 tool_calls 的 assistant 是否整条丢弃）。 */
function isContentBlank(content: unknown): boolean {
  if (content == null) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (Array.isArray(content)) {
    // 空数组视为空白
    if (content.length === 0) return true;
    // 非空数组只要任一 text part 有非空白文本即视为有内容；保守起见，
    // 全部 part 都不贡献文本时才算空白。对于未知 part 类型（Anthropic 风格
    // {type:"image", source}、音频、文件、未来扩展等），保守视为有内容
    // （返回 true），避免误判为空白而把带其他模态的 assistant 整条丢弃。
    return !content.some((part) => {
      if (part == null || typeof part !== "object") return false;
      const p = part as { type?: string; text?: unknown; image_url?: { url?: unknown } };
      if (p.type === "text") return typeof p.text === "string" && p.text.trim().length > 0;
      if (p.type === "image_url") {
        const url = p.image_url?.url;
        return typeof url === "string" && url.trim().length > 0;
      }
      // 其余非空对象 part（未知类型）保守视为有内容，避免误删多模态 assistant。
      return true;
    });
  }
  return false;
}

/**
 * 单次遍历 + 重排：建索引后按原顺序输出非 tool 消息，遇到带 `tool_calls` 的
 * assistant 时紧接其后输出已匹配的 tool 消息。
 */
export function sanitizeToolCallPairing<T extends AnyMessage>(messages: T[]): T[] {
  // 1. 建索引：callId -> 声明它的 assistant 下标（取第一个声明者）
  const assistantIndexByCallId = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m == null) continue;
    if (m.role !== "assistant") continue;
    const toolCalls = m.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      const id = call?.id;
      if (typeof id !== "string" || !id) continue;
      if (!assistantIndexByCallId.has(id)) {
        assistantIndexByCallId.set(id, i);
      }
    }
  }

  // 2. 收集 tool 消息：callId -> 第一个匹配的 tool 消息（重复 id 取首条，其余当孤儿丢）
  const toolByCallId = new Map<string, T>();
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m == null) continue;
    if (m.role !== "tool") continue;
    const id = readToolCallId(m);
    if (typeof id !== "string" || !id) continue;
    if (!toolByCallId.has(id)) {
      toolByCallId.set(id, m);
    }
  }

  const output: T[] = [];
  const consumedToolCallIds = new Set<string>();

  // 3. 按原顺序输出；tool 消息在原位跳过
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m == null) continue;
    if (m.role === "tool") continue; // tool 消息在原位跳过，由 assistant 紧接其后输出

    if (m.role !== "assistant") {
      output.push(m);
      continue;
    }

    const toolCalls = m.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      // assistant 无 tool_calls：原样保留（即使 content 为空，也维持原状，
      // 不在此处删除——空 assistant 留给上层空轮逻辑处理）
      output.push(m);
      continue;
    }

    // 4. 对 assistant 的 tool_calls 逐条匹配 tool 消息
    const matchedToolCalls: typeof toolCalls = [];
    const matchedToolMessages: T[] = [];
    for (const call of toolCalls) {
      const id = call?.id;
      if (typeof id !== "string" || !id) continue; // 无 id 的 tool_call 直接剔除
      const toolMessage = toolByCallId.get(id);
      // 必须由本 assistant 声明，且本 assistant 是该 id 的第一个声明者
      // （避免被别的 assistant 抢占）。但只要 tool 消息存在且本 assistant 声明过即可。
      if (!toolMessage) continue; // 匹配不到 tool 结果 → 剔除该 tool_call
      if (assistantIndexByCallId.get(id) !== i) continue; // 本 assistant 不是第一声明者 → 留给声明者
      if (consumedToolCallIds.has(id)) continue; // 已被消费（重复）
      matchedToolCalls.push(call);
      matchedToolMessages.push(toolMessage);
      consumedToolCallIds.add(id);
    }

    if (matchedToolCalls.length === 0) {
      // 4b. tool_calls 全部匹配不上：从数组里剔除 → 为空 → 删掉 tool_calls 字段
      const { tool_calls: _drop, ...rest } = m;
      const stripped = rest as T;
      if (isContentBlank(stripped.content)) {
        // content 为空/仅空白 → 整条丢弃
        continue;
      }
      output.push(stripped);
      continue;
    }

    // 5. 输出 assistant（保留匹配上的 tool_calls，剔除未匹配的），
    //    紧接着按 tool_calls 顺序输出已匹配的 tool 消息
    const normalizedAssistant = { ...m, tool_calls: matchedToolCalls } as T;
    output.push(normalizedAssistant);
    for (const toolMessage of matchedToolMessages) {
      output.push(toolMessage);
    }
  }

  // 6. 孤儿 tool 消息（未匹配到任何 assistant 声明）已在 step 3 原位跳过，
  //    且未在 step 5 输出 → 自动丢弃。

  return output;
}