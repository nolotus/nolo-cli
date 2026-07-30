import type { MemoryItem } from "./types";

const KIND_TITLES: Record<MemoryItem["kind"], string> = {
  episodic: "Episodic",
  semantic: "Semantic",
  procedural: "Procedural",
};

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

export const buildMemoryOverlay = (items: MemoryItem[]): string | null => {
  if (items.length === 0) return null;

  const byKind: Record<string, MemoryItem[]> = {
    episodic: [],
    semantic: [],
    procedural: [],
  };
  for (const item of items) {
    byKind[item.kind].push(item);
  }

  const sections = Object.entries(byKind)
    .filter(([, list]) => list.length > 0)
    .map(([kind, list]) => {
      const lines = list.slice(0, 3).map((item) => `- ${normalizeDisplayContent(item)}`);
      return [`[${KIND_TITLES[kind as MemoryItem["kind"]]}]`, ...lines].join("\n");
    });

  return [
    "--- Memory Overlay ---",
    "以下是当前请求可用的记忆事实；相关时直接基于这些记忆回答。",
    "用户当前输入优先于记忆；记忆只辅助理解，不要求迎合。",
    "",
    ...sections,
  ].join("\n");
};
