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
import { canonicalizeToolName } from "./toolNameAliases";
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

严格只输出下面三部分，标题必须完全一致：
关键事实档案
- ...
对话进展与待办
- ...
文件操作清单
- ...

要求：
1) 使用对话主语言；混合语言时优先用户主要语言；专有名词、文件路径、标识符、命令保留原文。
2) 关键事实档案只保留之后继续对话仍有价值的信息：用户目标/偏好、约束、技术栈、确定的文件路径、核心决策、未完成待办。
3) 对话进展与待办：先极简概括旧上下文，再更详细记录最近进展、结论、分歧与下一步。
4) 文件操作清单：列出本次压缩范围内读取、写入、编辑过的文件路径及操作类型（如: - 读取: path/to/file；若未涉及文件操作写"无"）。
5) 忽略寒暄、重复尝试、已放弃方案和无价值废话。
6) 不要编造未出现的信息；不要开场白、结束语、markdown 代码块或额外章节；不要调用任何工具。`;

export type FileOperation = {
  type: "read" | "write" | "edit";
  path: string;
};

export function extractFileOperations(
  msgs: PlanCompressionBridgeMessage[],
): FileOperation[] {
  const result: FileOperation[] = [];
  const seen = new Set<string>();

  for (const msg of msgs) {
    if (!Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      const name =
        call.function?.name || (call as { name?: string }).name || "";
      if (!name) continue;

      // Canonicalize model aliases first, then classify only local file tools.
      // This preserves read/edit/write tool calls without misclassifying
      // readDoc/readAgent/writeRow as filesystem operations.
      const canonicalName = canonicalizeToolName(name);
      const fileOperationByTool: Record<string, FileOperation["type"]> = {
        readFile: "read",
        writeFile: "write",
        editFile: "edit",
      };
      const opType = fileOperationByTool[canonicalName];

      if (!opType) continue;

      let rawArgs =
        call.function?.arguments ??
        (call as { arguments?: unknown }).arguments;
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
        parsedArgs?.path ?? parsedArgs?.filePath ?? parsedArgs?.file;
      if (typeof path === "string" && path.trim()) {
        const key = `${opType}:${path.trim()}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ type: opType, path: path.trim() });
        }
      }
    }
  }

  return result;
}

export function formatFileOperations(
  msgs: PlanCompressionBridgeMessage[],
): string {
  const ops = extractFileOperations(msgs);
  if (ops.length === 0) {
    return "无";
  }
  const typeLabelMap = {
    read: "读取",
    write: "写入",
    edit: "编辑",
  };
  return ops
    .map((op) => `- ${typeLabelMap[op.type]}: ${op.path}`)
    .join("\n");
}

export function buildLocalAutoCompactionUserContent(
  previousSummary: string,
  messagesText: string,
  fileOpsText?: string,
): string {
  const parts = [`【现有记忆】：\n${previousSummary || "(无)"}`];
  if (fileOpsText !== undefined) {
    parts.push(`【文件操作清单】：\n${fileOpsText || "无"}`);
  }
  parts.push(`【新增对话】：\n${messagesText}`);
  return parts.join("\n\n").trim();
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

/**
 * 认为 provider 前缀缓存已过期的静默时长。
 *
 * 取值偏保守：误判为「已过期」会生成新摘要、改变前缀，把本来还热的缓存毁掉。
 * 常见 provider 的前缀缓存 TTL 在分钟到小时量级，取 60 分钟留足余量。
 */
export const COLD_RESUME_IDLE_MS = 60 * 60 * 1000;

/** 距最后一条带时间戳的历史消息是否已超过 COLD_RESUME_IDLE_MS。 */
export function isColdResume(
  history: AgentRuntimeChatMessage[],
  nowMs: number,
): boolean {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const at = history[i]?.createdAt;
    if (typeof at === "number" && Number.isFinite(at)) {
      return nowMs - at > COLD_RESUME_IDLE_MS;
    }
  }
  // 历史不带时间戳（旧记录或不支持的 host）→ 不触发，保持既有行为。
  return false;
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
  /** 可注入的当前时间，供 cold-resume 判定使用；测试用来保持确定性。 */
  now?: () => number;
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
  // Cold-resume 判定：距上次活动很久再继续的对话，provider 前缀缓存必然已过期，
  // 这一轮无论如何都要全量重发整个上下文。那正是压缩最划算的时刻——反正要付
  // 全量未命中的钱，不如让重发的那份小一点，且后续每一轮都跟着受益。
  //
  // 阈值方向必须保守：若缓存其实还热却误触发，新摘要会改变前缀、把热缓存毁掉。
  // 所以取一个明显高于常见 provider TTL 的值，宁可漏判也不误判。
  const coldResume = isColdResume(history, args.now?.() ?? Date.now());

  const plan = planCompression({
    allMsgs: allMsgs as any,
    summarizedBeforeId,
    summary: existingSummary,
    contextWindow,
    ...(coldResume ? { force: true, reason: "context_budget" as const } : {}),
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
    const msgsToCompress =
      plan.msgsToCompress as PlanCompressionBridgeMessage[];
    const messagesText = formatMessagesForLocalSummary(msgsToCompress);
    const fileOpsText = formatFileOperations(msgsToCompress);
    const promptContent = buildLocalAutoCompactionUserContent(
      existingSummary,
      messagesText,
      fileOpsText,
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
