/**
 * 对话压缩的共享逻辑：web 端 `updateDialogSummaryAction` 和 local 端
 * `localAutoCompaction` 共用同一套摘要 prompt、消息格式化和文件操作提取。
 *
 * 之前两套实现各自维护一份 prompt（web 两段式、local 三段式），导致同一对话
 * 在 web 和 CLI 摘要格式不一致。现在统一到三段式（含文件操作清单），并提取
 * 共享函数避免漂移。
 *
 * --- 添加新的压缩路径 ---
 *
 * 如果要加第四套压缩实现（如 mobile），按以下步骤：
 * 1. 决策：调 `planCompression(input)` 获取 CompressionPlan
 * 2. 格式化：调 `formatMessagesForSummaryWithTruncation(plan.msgsToCompress)`
 *    + `formatFileOperationsFromMessages(msgs, resolveCanonicalName)`
 * 3. 构造 prompt：调 `buildCompactionUserContent({ previousSummary, messagesText, fileOpsText })`
 * 4. 调 LLM：system message 用 `COMPACTION_SUMMARY_SYSTEM_PROMPT`
 * 5. 落库：存 summary + summarizedBeforeId + referenceKeys + compressionCount
 * 6. 注入：用 `wrapHistoricalSummaryWithReplayGuard(summary)` 包装后注入
 * 7. 埋点：调 `buildCompactionMetricsFromPlan({ reason, previousSummary, plan, newSummary })`
 */

import { serializeMessageContent } from "../../chat/messages/messageContent";
import { estimateTokenCount } from "./tokenUtils";
import { getMessageTokenCount, type TokenCountableMessage } from "./planCompression";

// --- 摘要 prompt ---

/**
 * 统一的对话上下文压缩 system prompt。
 *
 * 三段式输出（关键事实档案 / 对话进展与待办 / 文件操作清单），比原 web 两段式
 * 多了文件操作清单，让摘要能直接回答"之前动过哪些文件"，续作时不必重新扫描。
 *
 * P0-3 增强（学 Kimi 第一人称 handoff）：
 * - 摘要以 agent 第一人称续作笔记的口吻写，不是第三方报告
 * - 保留确切命令、文件路径、变量名、错误信息原文
 * - 标注"声称已做但未验证"的工作（而非默认信任）
 * - 让接收摘要的 agent 从摘要自然续作并复核未验证项
 *
 * 明确禁止调工具，避免对话 agent 的 tool schema 干扰单次 complete。
 */
export const COMPACTION_SUMMARY_SYSTEM_PROMPT = `你是对话上下文压缩器。根据【现有记忆】和【新增对话】，输出可替代原始消息的事实性要点，供后续对话直接使用。

严格只输出下面三部分，标题必须完全一致：
关键事实档案
- ...
对话进展与待办
- ...
文件操作清单
- ...

要求：
1) 使用对话主语言；混合语言时优先用户主要语言；专有名词、文件路径、标识符、命令保留原文，不要翻译或转述。
2) 关键事实档案只保留之后继续对话仍有价值的信息：用户目标/偏好、约束、技术栈、确定的文件路径、核心决策、未完成待办。保留确切值（端口号、版本号、路径、变量名、错误信息原文），不要概括成"某个端口"或"某个文件"或"某报错"。
3) 对话进展与待办以第一人称续作笔记的口吻写（"我做了…""用户要求…""下一步我需要…"），不要写成第三方观察报告。先极简概括旧上下文，再更详细记录最近进展、结论、分歧与下一步。对于声称已完成但尚未验证的工作（如工具调用返回成功但结果未人工确认），明确标注"（待验证）"——不要默认信任工具返回值。
4) 文件操作清单：列出本次压缩范围内读取、写入、编辑过的文件路径及操作类型（如: - 读取: path/to/file；若未涉及文件操作写"无"）。
5) 忽略寒暄、重复尝试、已放弃方案和无价值废话。
6) 不要编造未出现的信息；不要开场白、结束语、markdown 代码块或额外章节；不要调用任何工具。`;

// --- 消息格式化 ---

/**
 * content 为空时的 fallback：用 tool_calls 函数名或占位符。
 * 提取为私有函数避免 formatMessagesForSummary 和截断版重复。
 */
function formatMessageContentFallback(msg: {
  content: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
}): string {
  const content = serializeMessageContent(msg.content);
  if (content) return content;
  if (Array.isArray(msg.tool_calls)) {
    return `[tool_calls:${msg.tool_calls
      .map((c) => c.function?.name)
      .filter(Boolean)
      .join(",")}]`;
  }
  return "[非文本内容]";
}

/**
 * 把消息序列格式化成摘要 LLM 可读的纯文本（无截断）。
 *
 * 兼容 web Message 和 local PlanCompressionBridgeMessage。
 * tool_calls 无 content 时用函数名做 fallback 标记，避免空行。
 */
export function formatMessagesForSummary(
  msgs: Array<{
    role: string;
    content: unknown;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>,
): string {
  return formatMessagesForSummaryWithTruncation(msgs, Infinity);
}

/**
 * 构造摘要 user message 内容：现有记忆 + 文件操作清单 + 新增对话。
 *
 * 文件操作清单可选（web 端首次接入时可不传，降级为两段式输入格式）。
 */
export function buildCompactionUserContent(args: {
  previousSummary: string;
  messagesText: string;
  fileOpsText?: string;
}): string {
  const parts = [`【现有记忆】：\n${args.previousSummary || "(无)"}`];
  if (args.fileOpsText !== undefined) {
    parts.push(`【文件操作清单】：\n${args.fileOpsText || "无"}`);
  }
  parts.push(`【新增对话】：\n${args.messagesText}`);
  return parts.join("\n\n").trim();
}

// --- 文件操作提取 ---

export type FileOperation = {
  type: "read" | "write" | "edit";
  path: string;
};

/**
 * 从 tool_calls 里提取文件操作（read/write/edit）。
 *
 * 依赖调用方传入 canonicalize 后的 tool name 映射；这里只做字段提取，
 * 不耦合具体的 tool name 别名系统（web 和 local 的 tool name 可能不同）。
 */
export function extractFileOperationsFromCalls(
  calls: Array<{
    function?: { name?: string; arguments?: unknown };
    name?: string;
  }>,
  resolveCanonicalName: (name: string) => string,
): FileOperation[] {
  const result: FileOperation[] = [];
  const seen = new Set<string>();
  const fileOperationByTool: Record<string, FileOperation["type"]> = {
    readFile: "read",
    writeFile: "write",
    editFile: "edit",
  };

  for (const call of calls) {
    const rawName = call.function?.name || call.name || "";
    if (!rawName) continue;

    const canonicalName = resolveCanonicalName(rawName);
    const opType = fileOperationByTool[canonicalName];
    if (!opType) continue;

    let rawArgs = call.function?.arguments;
    let parsedArgs: Record<string, unknown> | null = null;

    if (typeof rawArgs === "string") {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        // ignore invalid JSON
      }
    } else if (typeof rawArgs === "object" && rawArgs !== null) {
      parsedArgs = rawArgs as Record<string, unknown>;
    }

    const path =
      (parsedArgs as Record<string, unknown> | null)?.path ??
      (parsedArgs as Record<string, unknown> | null)?.filePath ??
      (parsedArgs as Record<string, unknown> | null)?.file;
    if (typeof path === "string" && path.trim()) {
      const key = `${opType}:${path.trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ type: opType, path: path.trim() });
      }
    }
  }

  return result;
}

/**
 * 从消息序列里提取所有文件操作并格式化为摘要 prompt 用的文本。
 *
 * 需要调用方提供 `resolveCanonicalName` 来把可能的 tool name 别名映射到
 * readFile/writeFile/editFile，避免本模块耦合 tool alias 系统。
 */
export function formatFileOperationsFromMessages(
  msgs: Array<{
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  }>,
  resolveCanonicalName: (name: string) => string,
): string {
  const allOps: FileOperation[] = [];
  for (const msg of msgs) {
    if (!Array.isArray(msg.tool_calls)) continue;
    allOps.push(
      ...extractFileOperationsFromCalls(msg.tool_calls, resolveCanonicalName),
    );
  }
  if (allOps.length === 0) return "无";

  const typeLabelMap: Record<FileOperation["type"], string> = {
    read: "读取",
    write: "写入",
    edit: "编辑",
  };
  return allOps.map((op) => `- ${typeLabelMap[op.type]}: ${op.path}`).join("\n");
}

// --- 工具结果截断（P0-2，学 Pi） ---

/**
 * 单个工具结果在摘要输入里的最大字符数。
 *
 * 超长的工具结果（如读取大文件）截断到这个长度并加标记，避免摘要请求本身
 * 被撑爆。取 4000 字符（约 1000 token），比 Pi 的 2000 更宽松一些，因为
 * bun-nolo 的工具结果常含文件路径和关键错误信息，截太狠会丢上下文。
 */
export const TOOL_RESULT_TRUNCATE_CHARS = 4000;

/**
 * 截断消息的 content 用于摘要输入。
 *
 * 只对 role=tool 的消息截断（工具结果通常最大）；其他消息原样返回。
 * 截断后加标记注明截断了多少字符，让摘要 LLM 知道有内容被省略。
 */
export function truncateContentForSummary(
  role: string,
  content: string,
  maxChars: number = TOOL_RESULT_TRUNCATE_CHARS,
): string {
  if (role !== "tool" || content.length <= maxChars) return content;
  const truncated = content.slice(0, maxChars);
  const omitted = content.length - maxChars;
  return `${truncated}\n\n[... ${omitted} chars truncated ...]`;
}

/**
 * 带截断的消息格式化：先截断工具结果，再格式化。
 *
 * 这是 formatMessagesForSummary 的截断增强版，用于实际压缩调用。
 */
export function formatMessagesForSummaryWithTruncation(
  msgs: Array<{
    role: string;
    content: unknown;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>,
  maxToolResultChars: number = TOOL_RESULT_TRUNCATE_CHARS,
): string {
  return msgs
    .map((msg) => {
      const rawContent = serializeMessageContent(msg.content) || "";
      const truncated = truncateContentForSummary(
        msg.role,
        rawContent,
        maxToolResultChars,
      );
      const text = truncated || formatMessageContentFallback(msg);
      return `${msg.role}: ${text}`;
    })
    .join("\n");
}
// --- 压缩埋点 metrics (P1-8) ---

/**
 * 一次压缩事件的 metrics 记录。
 *
 * 用于观测压缩效果和成本：压缩前后 token 对比能看出压缩收益，
 * 摘要 LLM 用量能算出压缩本身的成本，触发原因能指导阈值调优。
 */
export interface CompactionMetrics {
  /** 触发原因 */
  reason: string;
  /** 压缩前已有 summary 的 token 数 */
  previousSummaryTokens: number;
  /** 被压缩消息的 token 数 */
  compressedTokens: number;
  /** 保留尾部消息的 token 数 */
  retainedTokens: number;
  /** 新 summary 的 token 数（压缩后） */
  newSummaryTokens: number;
  /** 被压缩消息数 */
  compressedCount: number;
  /** 保留尾部消息数 */
  retainedCount: number;
  /** 摘要 LLM 调用的 usage（如果有） */
  summaryUsage?: Record<string, unknown>;
  /** 是否有前序摘要（用于判断首次压缩 vs 增量压缩） */
  hadPreviousSummary: boolean;
}

/**
 * 构造压缩 metrics 记录。纯函数：不调 LLM、不写 DB。
 */
export function buildCompactionMetrics(args: {
  reason: string;
  previousSummary: string;
  msgsToCompress: TokenCountableMessage[];
  msgsToKeep: TokenCountableMessage[];
  newSummary: string;
  summaryUsage?: Record<string, unknown>;
  estimateTokens: (text: string) => number;
  estimateMessageTokens: (msg: TokenCountableMessage) => number;
}): CompactionMetrics {
  const {
    reason, previousSummary, msgsToCompress, msgsToKeep,
    newSummary, summaryUsage, estimateTokens, estimateMessageTokens,
  } = args;
  return {
    reason,
    previousSummaryTokens: estimateTokens(previousSummary || ""),
    compressedTokens: msgsToCompress.reduce((s, m) => s + estimateMessageTokens(m), 0),
    retainedTokens: msgsToKeep.reduce((s, m) => s + estimateMessageTokens(m), 0),
    newSummaryTokens: estimateTokens(newSummary || ""),
    compressedCount: msgsToCompress.length,
    retainedCount: msgsToKeep.length,
    summaryUsage,
    hadPreviousSummary: previousSummary.trim().length > 0,
  };
}

/**
 * 从 CompressionPlan 构造 metrics 的便捷函数。
 *
 * 三套压缩路径（web / local / CLI）都用 planCompression 做决策，
 * 调用方只需传 plan + reason + newSummary + 可选 summaryUsage，
 * 不用每次都手动传 estimateTokens / estimateMessageTokens。
 */
export function buildCompactionMetricsFromPlan(args: {
  reason: string;
  previousSummary: string;
  plan: { msgsToCompress: TokenCountableMessage[]; msgsToKeep: TokenCountableMessage[] };
  newSummary: string;
  summaryUsage?: Record<string, unknown>;
}): CompactionMetrics {
  return buildCompactionMetrics({
    reason: args.reason,
    previousSummary: args.previousSummary,
    msgsToCompress: args.plan.msgsToCompress,
    msgsToKeep: args.plan.msgsToKeep,
    newSummary: args.newSummary,
    summaryUsage: args.summaryUsage,
    estimateTokens: estimateTokenCount,
    estimateMessageTokens: getMessageTokenCount,
  });
}

/**
 * 格式化成人类可读的单行日志。
 * 示例: [Compaction] reason=context_budget compressed=15->2 msgs, tokens=12500->3200 (ratio=0.26)
 */
export function formatCompactionMetricsLog(metrics: CompactionMetrics): string {
  const totalBefore = metrics.previousSummaryTokens + metrics.compressedTokens;
  const totalAfter = metrics.newSummaryTokens + metrics.retainedTokens;
  const ratio = totalBefore > 0 ? (totalAfter / totalBefore).toFixed(2) : "N/A";
  const llmInfo = metrics.summaryUsage
    ? `, summary_llm_in=${metrics.summaryUsage.input_tokens ?? "?"} out=${metrics.summaryUsage.output_tokens ?? "?"}`
    : "";
  return `[Compaction] reason=${metrics.reason} compressed=${metrics.compressedCount}->${metrics.retainedCount} msgs, tokens=${totalBefore}->${totalAfter} (ratio=${ratio})${llmInfo}`;
}
