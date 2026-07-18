/**
 * 工具调用 arguments 非法 JSON 防护。
 *
 * 背景：流式生成大体积 tool_call（如 appDeploy 把整个应用源码塞进 arguments）
 * 时，若上游在输出长度上限处截断，会产生无法 JSON.parse 的 arguments 字符串。
 * 一旦这条 assistant 消息（含坏 tool_calls）被持久化进 dialog 历史，下一次
 * 请求回放历史时 provider 会直接拒绝：
 *   `Invalid tool call in messages: tool_calls[].function.arguments ...
 *    must be a JSON object string (or an object), got invalid JSON`
 * 之后该对话每次请求都带着坏消息，永久卡死。
 *
 * 本模块提供两层防护的纯函数工具：
 *
 * 防护 A（流结束时校验）：见 `parseToolCallArguments` / `isArgumentsInvalid`，
 * 供 sendOpenAI*Request 在 tool call 即将被执行/持久化的边界做校验。
 *
 * 防护 B（出站清洗）：见 `sanitizeOutboundMessages` /
 * `sanitizeOutboundResponsesInput`，供出站请求组装路径把历史消息里
 * 无法 parse 的 arguments 替换成合法 JSON 占位，并为缺失配对结果的
 * tool call 补一条占位 tool / function_call_output 消息，避免孤儿 tool
 * 消息触发另一类 400。
 *
 * 本模块是纯函数；仅依赖 core/isRecord 做 plain-object 判定，方便单测。
 */

import { isRecord } from "../../core/isRecord";

/**
 * 流结束时替换坏 arguments 用的合法 JSON 字符串（带原因，提示下游/模型）。
 * 注意：必须是合法 JSON 对象字符串，本身能被 JSON.parse。
 */
export const INVALID_TOOL_ARGS_REPLACEMENT =
  '{"_invalid":true,"_reason":"arguments truncated or malformed"}';

/**
 * 出站清洗历史消息时用的更短占位（只要能过 provider 的 JSON 校验即可，
 * 历史里的坏调用不需要再带长原因——自愈主要靠防护 A 在写入时追加的
 * tool 结果消息）。
 */
export const INVALID_TOOL_ARGS_OUTBOUND_REPLACEMENT = '{"_invalid":true}';

/**
 * 防护 A：坏 tool call 对应的 tool 角色结果消息内容，指导模型自愈。
 * 用 JSON 字符串包装，与现有 tool 消息 content 习惯一致。
 */
export const INVALID_TOOL_RESULT_HINT =
  "工具参数 JSON 被截断（大概率超出输出长度）。不要把完整源码塞进一次工具调用：先用 appFileWrite 分文件多次写入，再调用不带内联大参数的 appPreflight/appDeploy。";

/**
 * 防护 B：为缺失配对结果的 tool call 补的占位 tool 消息内容。
 */
export const ORPHAN_TOOL_RESULT_PLACEHOLDER = '{"error":"tool call was interrupted"}';

/**
 * 解析 tool call 的 arguments。
 *
 * - string：尝试 JSON.parse（去掉首尾空白）。
 * - object（非数组）：视为已合法，原样返回。
 * - 其它（undefined / null / 数组 / 基础类型）：视为非法。
 *
 * 返回 { valid, parsed }。parsed 仅在 valid 且原值是 string 时给出解析结果，
 * 方便调用方直接复用已解析对象，避免重复 parse。
 */
export function parseToolCallArguments(
  args: unknown
): { valid: boolean; parsed?: any } {
  if (isRecord(args)) {
    // 已经是对象，视为合法（provider 接受 object 或 JSON 字符串）
    return { valid: true, parsed: args };
  }
  if (typeof args !== "string") return { valid: false };

  const trimmed = args.trim();
  if (!trimmed) return { valid: false };
  try {
    const parsed = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      // JSON.parse 出来不是对象（如 "123" / "true" / '"x"'），provider 仍可能
      // 接受，但 tool arguments 按约定应是对象；按非法处理，避免后续执行异常。
      return { valid: false };
    }
    return { valid: true, parsed };
  } catch {
    return { valid: false };
  }
}

export function isArgumentsInvalid(args: unknown): boolean {
  return !parseToolCallArguments(args).valid;
}

/**
 * 把任意 arguments 规范成「合法 JSON 对象字符串」。
 * - 已合法的 string：原样返回（保留 provider 期望的字符串形态）。
 * - object：JSON.stringify。
 * - 非法：返回 replacement（默认 INVALID_TOOL_ARGS_REPLACEMENT）。
 */
export function toValidArgumentsString(
  args: unknown,
  replacement: string = INVALID_TOOL_ARGS_REPLACEMENT
): string {
  const { valid } = parseToolCallArguments(args);
  if (!valid) return replacement;
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return replacement;
  }
}

/**
 * 防护 A：构造坏 tool call 的自愈 tool 结果消息负载。
 *
 * 返回一个可直接作为 tool 消息 content 的 JSON 字符串，包含 error + hint。
 * 调用方负责把它包成 { role: "tool", tool_call_id, content } 并持久化。
 */
export function buildInvalidToolCallSelfHealResult(
  callId: string,
  toolName?: string
): string {
  return JSON.stringify({
    error: true,
    toolCallId: callId,
    ...(toolName ? { toolName } : {}),
    message: INVALID_TOOL_RESULT_HINT,
  });
}

/* ------------------------------------------------------------------ */
/* 防护 B：出站清洗                                                    */
/* ------------------------------------------------------------------ */

/**
 * 规范化单个 tool_call 的 arguments 为合法 JSON 对象字符串。
 * 原地修改传入的 call 对象（用于已克隆后的消息）。
 */
function normalizeToolCallArgumentsInPlace(
  call: any,
  replacement: string
): void {
  if (!call || typeof call !== "object") return;
  const fn = call.function;
  if (!fn || typeof fn !== "object") return;
  const { valid } = parseToolCallArguments(fn.arguments);
  if (!valid) {
    fn.arguments = replacement;
  } else if (typeof fn.arguments !== "string") {
    // provider 期望 string；对象形态也 stringify 一下，保持一致
    try {
      fn.arguments = JSON.stringify(fn.arguments);
    } catch {
      fn.arguments = replacement;
    }
  }
}

/**
 * 防护 B（chat/completions 形态）：清洗出站 messages。
 *
 * 1. assistant 消息的每个 tool_calls[]：arguments 无法 parse → 替换为
 *    `{"_invalid":true}` 字符串。不丢消息本身，保留 call_id，避免下游
 *    tool 消息变孤儿。
 * 2. 若历史中存在 tool_call 但缺配对 tool 结果消息（截断场景常见），
 *    在该 assistant 消息之后补一条占位 tool 消息，内容为
 *    `{"error":"tool call was interrupted"}`，role/tool_call_id 齐全，
 *    避免孤儿 tool_call 触发 provider 另一类 400。
 *
 * 返回新的 messages 数组（不修改入参）。
 */
export function sanitizeOutboundMessages(
  messages: any[],
  opts: { argsReplacement?: string; orphanReplacement?: string } = {}
): any[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages ?? [];

  const argsReplacement =
    opts.argsReplacement ?? INVALID_TOOL_ARGS_OUTBOUND_REPLACEMENT;
  const orphanReplacement =
    opts.orphanReplacement ?? ORPHAN_TOOL_RESULT_PLACEHOLDER;

  // 先克隆 + 替换坏 arguments，并收集每个 assistant 拥有的 tool_call id
  const cloned: any[] = messages.map((msg) => ({ ...msg }));

  // 收集已有 tool 结果消息覆盖的 call_id
  const answeredCallIds = new Set<string>();
  for (const msg of cloned) {
    if (msg?.role === "tool" && typeof msg.tool_call_id === "string") {
      answeredCallIds.add(msg.tool_call_id);
    }
  }

  const result: any[] = [];
  for (const msg of cloned) {
    if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
      // 克隆 tool_calls 与其 function，避免污染共享引用
      msg.tool_calls = msg.tool_calls.map((call: any) => ({
        ...call,
        function: { ...(call?.function ?? {}) },
      }));
      for (const call of msg.tool_calls) {
        normalizeToolCallArgumentsInPlace(call, argsReplacement);
      }

      result.push(msg);

      // 为缺配对结果的 tool_call 补占位 tool 消息（紧跟 assistant 之后）
      for (const call of msg.tool_calls) {
        const callId = typeof call?.id === "string" ? call.id : undefined;
        if (!callId) continue;
        if (answeredCallIds.has(callId)) continue;
        answeredCallIds.add(callId); // 防止同一轮多个 assistant 重复补
        result.push({
          role: "tool",
          tool_call_id: callId,
          content: orphanReplacement,
        });
      }
      continue;
    }
    result.push(msg);
  }

  return result;
}

/**
 * 防护 B（responses API 形态）：清洗出站 input 项。
 *
 * responses API 的 input 是扁平的 item 数组：
 *   - { type: "function_call", call_id, name, arguments }
 *   - { type: "function_call_output", call_id, output }
 *
 * 1. function_call 的 arguments 无法 parse → 替换为 `{"_invalid":true}`。
 * 2. 若某个 function_call 缺配对的 function_call_output，补一条占位
 *    function_call_output，output 为 `{"error":"tool call was interrupted"}`。
 *
 * 返回新的 input 数组（不修改入参）。
 */
export function sanitizeOutboundResponsesInput(
  input: any[],
  opts: { argsReplacement?: string; orphanReplacement?: string } = {}
): any[] {
  if (!Array.isArray(input) || input.length === 0) return input ?? [];

  const argsReplacement =
    opts.argsReplacement ?? INVALID_TOOL_ARGS_OUTBOUND_REPLACEMENT;
  const orphanReplacement =
    opts.orphanReplacement ?? ORPHAN_TOOL_RESULT_PLACEHOLDER;

  const answeredCallIds = new Set<string>();
  for (const item of input) {
    if (item?.type === "function_call_output" && typeof item.call_id === "string") {
      answeredCallIds.add(item.call_id);
    }
  }

  const result: any[] = [];
  for (const item of input) {
    if (item?.type === "function_call") {
      const cloned = { ...item };
      const { valid } = parseToolCallArguments(cloned.arguments);
      if (!valid) {
        cloned.arguments = argsReplacement;
      } else if (typeof cloned.arguments !== "string") {
        try {
          cloned.arguments = JSON.stringify(cloned.arguments);
        } catch {
          cloned.arguments = argsReplacement;
        }
      }
      result.push(cloned);

      const callId = typeof cloned.call_id === "string" ? cloned.call_id : undefined;
      if (callId && !answeredCallIds.has(callId)) {
        answeredCallIds.add(callId);
        result.push({
          type: "function_call_output",
          call_id: callId,
          output: orphanReplacement,
        });
      }
      continue;
    }
    result.push(item);
  }

  return result;
}