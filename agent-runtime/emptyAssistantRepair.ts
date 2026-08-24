import type { AgentRuntimeMessageContent } from "./types";

/**
 * 空 assistant 回复修复协议常量与纯逻辑判定。
 *
 * 抽离为独立模块，确保前端 web 打包 / esbuild (platform: "browser")
 * 引入 repair prompt 时，不会意外带入 localLoop 及其 Node 原生模块依赖（child_process, fs, path）。
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
