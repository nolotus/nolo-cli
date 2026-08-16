import type { MemoryItem, MemoryFacet } from "./types";
import { EXPLICIT_REMEMBER_PREFIX_REGEX } from "./constants";

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

/** overlay 头部固定开销。压缩为一行——省 ~60 tokens 给记忆内容。 */
const OVERLAY_HEADER_LINES = [
  "--- Memory (相关时参考，用户输入优先) ---",
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

/**
 * facet → 显示文本的映射表。semantic 和 episodic 共用同一张表，
 * 只是前缀不同（semantic 用"用户当前…"，episodic 用"最近一次对话显示：用户…"）。
 *
 * `strip` 是 content 里可能带的前缀词，显示时去掉避免重复（如 "在权衡：在权衡 X" → "在权衡 X"）。
 */
const FACET_DISPLAY: Record<MemoryFacet, { label: string; strip: string }> = {
  unfinished: { label: "还没定下", strip: "还没决定" },
  tension:    { label: "在权衡",   strip: "在权衡" },
  preference: { label: "更在意",   strip: "更在意" },
  style:      { label: "更偏好",   strip: "更喜欢" },
  goal:       { label: "想推进",   strip: "想推进" },
};

const formatFacetContent = (
  facet: MemoryFacet,
  normalized: string,
  prefix: string,
): string => {
  const { label, strip } = FACET_DISPLAY[facet];
  const stripped = normalized.startsWith(strip) ? normalized.slice(strip.length).trim() : normalized;
  return `${prefix}${label} ${stripped}`;
};

const normalizeDisplayContent = (item: MemoryItem): string => {
  const normalized = item.content
    .trim()
    .replace(EXPLICIT_REMEMBER_PREFIX_REGEX, "")
    .replace(/[。！？!?]+$/u, "")
    .trim();

  if (item.kind === "semantic") {
    if (item.tags?.includes("understanding-memory") && item.facet) {
      return formatFacetContent(item.facet, normalized, "");
    }
    return normalized;
  }

  if (
    item.kind === "episodic" &&
    (item.patternKey === "explicit-remember" || item.patternKey === "agent-remember")
  ) {
    return normalized;
  }

  if (item.kind === "episodic" && item.tags?.includes("understanding-memory") && item.facet) {
    return formatFacetContent(item.facet, normalized, "上次: ");
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

  // 按预算截断：先固定开销，再按 kind 优先级 + 传入顺序逐条加入
  const remainingBudget = maxTokens - OVERLAY_HEADER_TOKENS;
  if (remainingBudget <= 0) {
    return OVERLAY_HEADER_LINES.join("\n");
  }

  // 把所有候选行展开，按 kind 优先级排序（semantic 先），同 kind 保持原 rank 顺序
  const allLines = (Object.entries(byKind) as [MemoryItem["kind"], MemoryItem[]][])
    .filter(([, list]) => list.length > 0)
    .flatMap(([kind, list]) =>
      list.slice(0, perKindLimit).map((item) => {
        const lineText = `- ${normalizeDisplayContent(item)}`;
        return { kind, lineText, lineTokens: estimateTokens(lineText) };
      })
    )
    .sort((a, b) => (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99));

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
