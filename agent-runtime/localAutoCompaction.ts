/**
 * localLoop 自动上下文压缩。
 *
 * 复用 web 端 `planCompression` 纯决策，在 CLI/桌面本地路径上：
 * 1) 判定是否需要压缩；2) 用当前 provider 生成事实性摘要；3) 摘要落盘；
 * 4) 把发给 provider 的历史投影为「摘要 + 保留尾部」。
 *
 * 硬约束：摘要只在压缩点生成一次并持久化。压缩点之间前缀必须稳定，
 * 否则会打掉 provider 前缀缓存（实测比不压缩更贵）。
 */

import { planCompression } from "../ai/context/planCompression";
import { getModelContextWindow } from "../ai/llm/getModelContextWindow";
import { serializeMessageContent } from "../core/chat/messageContentSerialize";
import type {
  AgentRuntimeHostAdapter,
  AgentRuntimeProvider,
} from "./hostAdapter";
import { buildDialogSummaryLayer } from "./turnContext";
import type { AgentRuntimeChatMessage } from "./types";

/** planCompression 实际读取的字段（见 packages/ai/context/planCompression.ts）。 */
export type PlanCompressionBridgeMessage = {
  id: string;
  role: AgentRuntimeChatMessage["role"];
  content: AgentRuntimeChatMessage["content"];
  tool_calls?: AgentRuntimeChatMessage["tool_calls"];
  usage?: { completion_tokens?: number };
};

/**
 * 摘要 system prompt。产出可替代原始消息的事实性要点，不是文学性总结。
 * 明确禁止调工具，避免对话 agent 的 tool schema 干扰单次 complete。
 */
export const LOCAL_AUTO_COMPACTION_SYSTEM_PROMPT = `你是对话上下文压缩器。根据【现有记忆】和【新增对话】，输出可替代原始消息的事实性要点，供后续对话直接使用。

严格只输出下面两部分，标题必须完全一致：
关键事实档案
- ...
对话进展与待办
- ...

要求：
1) 使用对话主语言；混合语言时优先用户主要语言；专有名词、文件路径、标识符、命令保留原文。
2) 关键事实档案只保留之后继续对话仍有价值的信息：用户目标/偏好、约束、技术栈、确定的文件路径、核心决策、未完成待办。
3) 对话进展与待办：先极简概括旧上下文，再更详细记录最近进展、结论、分歧与下一步。
4) 忽略寒暄、重复尝试、已放弃方案和无价值废话。
5) 不要编造未出现的信息；不要开场白、结束语、markdown 代码块或额外章节；不要调用任何工具。`;

export function buildLocalAutoCompactionUserContent(
  previousSummary: string,
  messagesText: string,
): string {
  return `【现有记忆】：
${previousSummary || "(无)"}

【新增对话】：
${messagesText}`.trim();
}

/**
 * AgentRuntimeChatMessage → planCompression 输入桥接。
 * 只映射判定所需字段：id / role / content / tool_calls / usage.completion_tokens。
 * id 用稳定的位置索引（历史只追加不重排），以便 summarizedBeforeId 跨轮对齐。
 */
export function toPlanCompressionMessages(
  history: AgentRuntimeChatMessage[],
): PlanCompressionBridgeMessage[] {
  return history.map((message, index) => {
    const usage = (message as { usage?: { completion_tokens?: number } }).usage;
    return {
      id: `local-${index}`,
      role: message.role,
      content: message.content,
      ...(Array.isArray(message.tool_calls)
        ? { tool_calls: message.tool_calls }
        : {}),
      ...(usage?.completion_tokens != null
        ? { usage: { completion_tokens: usage.completion_tokens } }
        : {}),
    };
  });
}

export function formatMessagesForLocalSummary(
  msgs: PlanCompressionBridgeMessage[],
): string {
  return msgs
    .map((msg) => {
      const content =
        serializeMessageContent(msg.content) ||
        (Array.isArray(msg.tool_calls)
          ? `[tool_calls:${msg.tool_calls.map((c) => c.function?.name).filter(Boolean).join(",")}]`
          : "[非文本内容]");
      return `${msg.role}: ${content}`;
    })
    .join("\n");
}

export function buildLocalSummaryHistoryMessage(
  summary: string,
): AgentRuntimeChatMessage {
  const layer = buildDialogSummaryLayer({ summary });
  return {
    role: "user",
    content:
      layer?.content ??
      `--- 历史对话摘要 ---\n${summary.trim()}`,
  };
}

export function projectHistoryWithSummary(args: {
  history: AgentRuntimeChatMessage[];
  summary: string;
  summarizedBeforeId?: string;
}): AgentRuntimeChatMessage[] {
  const bridged = toPlanCompressionMessages(args.history);
  let startIndex = 0;
  if (args.summarizedBeforeId) {
    const found = bridged.findIndex((m) => m.id === args.summarizedBeforeId);
    if (found !== -1) startIndex = found + 1;
  }
  return [
    buildLocalSummaryHistoryMessage(args.summary),
    ...args.history.slice(startIndex),
  ];
}

export type LocalAutoCompactionResult = {
  history: AgentRuntimeChatMessage[];
  /** True when history was projected through a (new or existing) summary. */
  compressed: boolean;
  /** True only when this call generated and persisted a new summary. */
  summaryGenerated: boolean;
  /**
   * 摘要生成那次 LLM 调用的用量。必须透出并由调用方并入本轮 turnUsage——
   * 否则这次消耗只出现在 provider 账单上，我们自己的 token 记账完全看不到，
   * 形成计费盲区（本轮改动的主题恰恰是成本可观测）。
   */
  usage?: Record<string, unknown>;
};

export async function maybeAutoCompactLocalHistory(args: {
  adapter: AgentRuntimeHostAdapter;
  dialogId?: string;
  history: AgentRuntimeChatMessage[];
  model?: string;
  /** Lazy provider resolver — only invoked when a new summary must be generated. */
  resolveProvider: () => Promise<AgentRuntimeProvider>;
  /** Test override; production uses getModelContextWindow(model). */
  contextWindow?: number;
}): Promise<LocalAutoCompactionResult> {
  const { adapter, dialogId, history } = args;
  const unchanged = (): LocalAutoCompactionResult => ({
    history,
    compressed: false,
    summaryGenerated: false,
  });

  if (
    !dialogId ||
    history.length === 0 ||
    typeof adapter.loadDialogSummary !== "function" ||
    typeof adapter.saveDialogSummary !== "function"
  ) {
    return unchanged();
  }

  let stored: { summary: string; summarizedBeforeId?: string } | null = null;
  try {
    stored = await adapter.loadDialogSummary(dialogId);
  } catch (error) {
    console.warn("[localLoop] loadDialogSummary failed:", error);
    return unchanged();
  }

  const existingSummary =
    typeof stored?.summary === "string" ? stored.summary : "";
  const summarizedBeforeId =
    typeof stored?.summarizedBeforeId === "string"
      ? stored.summarizedBeforeId
      : undefined;

  const contextWindow =
    typeof args.contextWindow === "number" &&
    Number.isFinite(args.contextWindow) &&
    args.contextWindow > 0
      ? args.contextWindow
      : getModelContextWindow(args.model ?? "");

  const allMsgs = toPlanCompressionMessages(history);
  const plan = planCompression({
    allMsgs: allMsgs as any,
    summarizedBeforeId,
    summary: existingSummary,
    contextWindow,
  });

  const projectExisting = (): LocalAutoCompactionResult => {
    if (!existingSummary.trim()) return unchanged();
    return {
      history: projectHistoryWithSummary({
        history,
        summary: existingSummary,
        summarizedBeforeId,
      }),
      compressed: true,
      summaryGenerated: false,
    };
  };

  if (!plan.shouldCompress) {
    return projectExisting();
  }

  try {
    const provider = await args.resolveProvider();
    const messagesText = formatMessagesForLocalSummary(
      plan.msgsToCompress as PlanCompressionBridgeMessage[],
    );
    const promptContent = buildLocalAutoCompactionUserContent(
      existingSummary,
      messagesText,
    );
    const result = await provider.complete([
      { role: "system", content: LOCAL_AUTO_COMPACTION_SYSTEM_PROMPT },
      { role: "user", content: promptContent },
    ]);
    const newSummary =
      typeof result.content === "string" ? result.content.trim() : "";
    if (!newSummary) {
      console.warn(
        "[localLoop] auto-compaction produced empty summary; keeping prior projection",
      );
      return projectExisting();
    }

    await adapter.saveDialogSummary({
      dialogId,
      summary: newSummary,
      summarizedBeforeId: plan.newSummarizedBeforeId,
    });

    return {
      history: projectHistoryWithSummary({
        history,
        summary: newSummary,
        summarizedBeforeId: plan.newSummarizedBeforeId,
      }),
      compressed: true,
      summaryGenerated: true,
      ...(result.usage ? { usage: result.usage as Record<string, unknown> } : {}),
    };
  } catch (error) {
    // 观测/优化功能：摘要失败绝不能让本轮对话失败。
    console.warn("[localLoop] auto-compaction failed:", error);
    return projectExisting();
  }
}
