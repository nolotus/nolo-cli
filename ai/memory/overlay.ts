import type { MemoryItem } from "./types";

const KIND_TITLES: Record<MemoryItem["kind"], string> = {
  episodic: "Episodic",
  semantic: "Semantic",
  procedural: "Procedural",
};

/**
 * 粗估 token 数。CJK 字符按 1.5 token 估算，ASCII 按 4 字符/token 估算。
 * 不追求精确——只需在预算截断时给出合理的相对度量。
 */
const estimateTokens = (text: string): number => {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x3400 && code <= 0x9fff) cjk += 1;
    else ascii += 1;
  }
  return Math.ceil(cjk * 1.5 + ascii / 4);
};

/** overlay 头部固定开销（标题 + 说明 + 空行）。 */
const OVERLAY_HEADER_LINES = [
  "--- Memory Overlay ---",
  "以下是当前请求可用的记忆事实；相关时直接基于这些记忆回答。",
  "用户当前输入优先于记忆；记忆只辅助理解，不要求迎合。",
  "",
];
const OVERLAY_HEADER_TOKENS = estimateTokens(OVERLAY_HEADER_LINES.join("\n"));

/**
 * 按 kind 优先级排序，用于预算截断时决定谁先留。
 * semantic > procedural > episodic——稳定事实优先于过程性知识，过程性优先于具体事件。
 */
const KIND_PRIORITY: Record<MemoryItem["kind"], number> = {
  semantic: 0,
  procedural: 1,
  episodic: 2,
};

export interface BuildMemoryOverlayOptions {
  /** 软上限 token 预算（粗估）。默认 800。超出时按 kind 优先级 + 传入顺序截断。 */
  maxTokens?: number;
  /** 每个 kind 最多显示几条。默认 3（向后兼容）。 */
  perKindLimit?: number;
}

const normalizeDisplayContent = (item: MemoryItem): string => {
  const normalized = item.content
    .trim()
    .replace(/^(你要记住|请记住|以后记住|记住)[，,。.\s:：]*/u, "")
    .replace(/[。！？!?]+$/u, "")
    .trim();
  const stripPrefix = (prefix: string) =>
    normalized.startsWith(prefix) ? normalized.slice(prefix.length).trim() : normalized;

  if (item.kind === "semantic") {
    if (item.tags?.includes("understanding-memory")) {
      switch (item.facet) {
        case "unfinished":
          return `用户仍未定下：${stripPrefix("还没决定")}`;
        case "tension":
          return `用户当前在权衡：${stripPrefix("在权衡")}`;
        case "preference":
          return `用户当前更在意：${stripPrefix("更在意")}`;
        case "style":
          return `用户互动偏好：${stripPrefix("更喜欢")}`;
        case "goal":
          return `用户当前目标：${stripPrefix("想推进")}`;
      }
    }
    return `用户长期偏好/事实：${normalized}`;
  }

  if (
    item.kind === "episodic" &&
    (item.patternKey === "explicit-remember" || item.patternKey === "agent-remember")
  ) {
    return `用户明确要求你记住：${normalized}`;
  }

  if (item.kind === "episodic" && item.tags?.includes("understanding-memory")) {
    switch (item.facet) {
      case "unfinished":
        return `最近一次对话显示：用户还没定下 ${stripPrefix("还没决定")}`;
      case "tension":
        return `最近一次对话显示：用户还在权衡 ${stripPrefix("在权衡")}`;
      case "preference":
        return `最近一次对话显示：用户更在意 ${stripPrefix("更在意")}`;
      case "style":
        return `最近一次对话显示：用户更偏好 ${stripPrefix("更喜欢")}`;
      case "goal":
        return `最近一次对话显示：用户想推进 ${stripPrefix("想推进")}`;
    }
  }

  return normalized;
};

export const buildMemoryOverlay = (
  items: MemoryItem[],
  options?: BuildMemoryOverlayOptions
): string | null => {
  if (items.length === 0) return null;

  const maxTokens = options?.maxTokens ?? 800;
  const perKindLimit = options?.perKindLimit ?? 3;

  const byKind: Record<string, MemoryItem[]> = {
    episodic: [],
    semantic: [],
    procedural: [],
  };
  for (const item of items) {
    byKind[item.kind].push(item);
  }

  // 每个 kind 取 top-N（保持传入的 rank 顺序）
  const cappedByKind: Array<[string, MemoryItem[]]> = Object.entries(byKind)
    .filter(([, list]) => list.length > 0)
    .map(([kind, list]) => [kind, list.slice(0, perKindLimit)] as [string, MemoryItem[]]);

  // 按预算截断：先固定开销，再按 kind 优先级 + 传入顺序逐条加入
  const remainingBudget = maxTokens - OVERLAY_HEADER_TOKENS;
  if (remainingBudget <= 0) {
    // 预算太小，连头部都放不下——只返回头部 + 空内容
    return OVERLAY_HEADER_LINES.join("\n");
  }

  // 把所有候选行展开成 [kind, lineText, lineTokens] 列表，按 kind 优先级排序
  interface CandidateLine {
    kind: string;
    lineText: string;
    lineTokens: number;
  }
  const allLines: CandidateLine[] = [];
  for (const [kind, list] of cappedByKind) {
    for (const item of list) {
      const lineText = `- ${normalizeDisplayContent(item)}`;
      allLines.push({
        kind,
        lineText,
        lineTokens: estimateTokens(lineText),
      });
    }
  }
  // 按 kind 优先级排序（semantic 先），同 kind 保持原 rank 顺序
  allLines.sort((a, b) => {
    const pa = KIND_PRIORITY[a.kind as MemoryItem["kind"]] ?? 99;
    const pb = KIND_PRIORITY[b.kind as MemoryItem["kind"]] ?? 99;
    return pa - pb;
  });

  // 预算内逐条加入；超预算的丢弃
  let usedTokens = 0;
  const keptByKind: Record<string, string[]> = {};
  for (const candidate of allLines) {
    if (usedTokens + candidate.lineTokens > remainingBudget) continue;
    usedTokens += candidate.lineTokens;
    if (!keptByKind[candidate.kind]) keptByKind[candidate.kind] = [];
    keptByKind[candidate.kind].push(candidate.lineText);
  }

  // 按 kind 标题顺序组装 sections（semantic → procedural → episodic）
  const kindOrder: MemoryItem["kind"][] = ["semantic", "procedural", "episodic"];
  const sections = kindOrder
    .filter((kind) => keptByKind[kind] && keptByKind[kind].length > 0)
    .map((kind) => {
      return [`[${KIND_TITLES[kind]}]`, ...keptByKind[kind]].join("\n");
    });

  if (sections.length === 0) {
    // 所有行都被预算截掉了——只返回头部
    return OVERLAY_HEADER_LINES.join("\n");
  }

  return [...OVERLAY_HEADER_LINES, ...sections].join("\n");
};
