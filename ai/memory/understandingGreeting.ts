import { asTrimmedString } from "../../core/trimmedString";
import { chooseMemoryOwners, loadMemoryCandidatesFromDb } from "./queryShared";
import type { MemoryFacet, MemoryItem } from "./types";

export interface UnderstandingGreetingResolution {
  item: MemoryItem | null;
  anchorItems: MemoryItem[];
  followUpItem: MemoryItem | null;
}

const UNDERSTANDING_TAG = "understanding-memory";

const facetPriority: Record<MemoryFacet, number> = {
  unfinished: 5,
  tension: 4,
  preference: 3,
  style: 2,
  goal: 1,
};

const anchorFacetPriority: Record<MemoryFacet, number> = {
  preference: 3,
  style: 2,
  goal: 1,
  tension: 0,
  unfinished: 0,
};

const normalizeText = (value: string): string =>
  value.trim().replace(/[。！？!?]+$/u, "").trim();

const stripPrefix = (text: string, prefix: string): string =>
  text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;

const toTimestamp = (item: MemoryItem): number => {
  const parsed = Date.parse(item.lastActivatedAt || item.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isUnderstandingItem = (item: MemoryItem): boolean =>
  Array.isArray(item.tags) && item.tags.includes(UNDERSTANDING_TAG);

/**
 * Greeting is the highest-risk memory surface: the agent speaks first.
 * Only memories confirmed across 2+ dialogs (consolidated to `semantic`)
 * with solid confidence may open the conversation. A single inferred
 * observation (episodic, 0.72–0.76) stays available for in-conversation
 * context but never fronts the greeting. One correction (-0.2) silences
 * a consolidated memory here (0.78–0.86 → below the bar).
 */
const GREETING_MIN_CONFIDENCE = 0.75;

const isGreetingEligible = (item: MemoryItem): boolean =>
  item.kind === "semantic" &&
  (item.confidence ?? 0) >= GREETING_MIN_CONFIDENCE;

const sortByKindAndTime = (left: MemoryItem, right: MemoryItem): number => {
  if (left.kind !== right.kind) return left.kind === "semantic" ? -1 : 1;
  return toTimestamp(right) - toTimestamp(left);
};

const sameNormalizedContent = (left: string, right: string): boolean =>
  normalizeText(left).toLowerCase() === normalizeText(right).toLowerCase();

const pickAnchorItems = (items: MemoryItem[]): MemoryItem[] => {
  const ranked = [...items]
    .filter((item) => (item.facet ? anchorFacetPriority[item.facet] > 0 : false))
    .sort((left, right) => {
      const leftFacet = left.facet ? anchorFacetPriority[left.facet] ?? 0 : 0;
      const rightFacet = right.facet ? anchorFacetPriority[right.facet] ?? 0 : 0;
      if (leftFacet !== rightFacet) return rightFacet - leftFacet;
      if (left.kind !== right.kind) return left.kind === "semantic" ? -1 : 1;
      if (left.content.length !== right.content.length) {
        return left.content.length - right.content.length;
      }
      return toTimestamp(right) - toTimestamp(left);
    });

  const selected: MemoryItem[] = [];
  for (const item of ranked) {
    if (
      selected.some((existing) =>
        sameNormalizedContent(existing.content, item.content) ||
        (existing.facet && item.facet && existing.facet === item.facet)
      )
    ) {
      continue;
    }
    selected.push(item);
    if (selected.length >= 2) break;
  }
  return selected;
};

const pickFollowUpItem = (items: MemoryItem[]): MemoryItem | null =>
  [...items]
    .filter((item) => item.facet === "unfinished" || item.facet === "tension")
    .sort((left, right) => {
      const leftFacet = left.facet ? facetPriority[left.facet] ?? 0 : 0;
      const rightFacet = right.facet ? facetPriority[right.facet] ?? 0 : 0;
      if (leftFacet !== rightFacet) return rightFacet - leftFacet;
      return sortByKindAndTime(left, right);
    })[0] ?? null;

export const resolveUnderstandingGreetingMemory = async (input: {
  db: any;
  userId?: string | null;
  spaceId?: string | null;
  agentKey: string;
}): Promise<UnderstandingGreetingResolution> => {
  const owners = chooseMemoryOwners({
    userId: input.userId,
    spaceId: input.spaceId,
  });
  if (owners.length === 0) {
    return { item: null, anchorItems: [], followUpItem: null };
  }

  const items = await loadMemoryCandidatesFromDb(input.db, {
    owners,
    subjects: [{ subjectType: "agent", subjectId: input.agentKey }],
    kinds: ["semantic", "episodic"],
    ownerLimit: 40,
    // Greeting memory must stay agent-scoped: a brand-new agent has zero
    // subject hits, and the owner fallback would surface user-level memories
    // from other agents/spaces as this agent's "memory".
    ownerFallback: "never",
  });

  const understandingItems = items.filter(
    (item) => isUnderstandingItem(item) && isGreetingEligible(item)
  );
  if (understandingItems.length === 0) {
    return { item: null, anchorItems: [], followUpItem: null };
  }

  const ranked = [...understandingItems].sort((left, right) => {
    const leftFacet = left.facet ? facetPriority[left.facet] ?? 0 : 0;
    const rightFacet = right.facet ? facetPriority[right.facet] ?? 0 : 0;
    if (leftFacet !== rightFacet) return rightFacet - leftFacet;
    return sortByKindAndTime(left, right);
  });

  const anchorItems = pickAnchorItems(understandingItems);
  const followUpItem = pickFollowUpItem(understandingItems);
  const item = followUpItem ?? anchorItems[0] ?? ranked[0] ?? null;

  return {
    item,
    anchorItems,
    followUpItem,
  };
};

const renderLeadClause = (item: MemoryItem): string => {
  const content = normalizeText(item.content);
  switch (item.facet) {
    case "unfinished":
      return `我记得你上次还没定下来：${stripPrefix(content, "还没决定")}`;
    case "tension":
      return `我记得你上次还在权衡${stripPrefix(content, "在权衡")}`;
    case "style":
    case "preference":
      return `我记得你上次${content}`;
    case "goal":
      return `我记得你上次想推进的是${content}`;
    default:
      return `我记得你上次提过${content}`;
  }
};

const renderAnchorFragment = (item: MemoryItem): string => {
  const content = normalizeText(item.content);
  switch (item.facet) {
    case "preference":
      if (content.startsWith("更在意")) {
        return `更在意的是${stripPrefix(content, "更在意")}`;
      }
      if (content.startsWith("更关心")) {
        return `更关心的是${stripPrefix(content, "更关心")}`;
      }
      if (content.startsWith("更怕")) {
        return `更怕${stripPrefix(content, "更怕")}`;
      }
      if (content.startsWith("不想")) {
        return `不想${stripPrefix(content, "不想")}`;
      }
      if (content.startsWith("不希望")) {
        return `不希望${stripPrefix(content, "不希望")}`;
      }
      return content;
    case "style":
      if (content.startsWith("不喜欢")) {
        return `不太喜欢${stripPrefix(content, "不喜欢")}`;
      }
      if (content.startsWith("更喜欢")) {
        return `更喜欢${stripPrefix(content, "更喜欢")}`;
      }
      return content;
    case "goal":
      if (content.startsWith("想先")) {
        return `想先${stripPrefix(content, "想先")}`;
      }
      return `想推进的是${content}`;
    default:
      return content;
  }
};

const renderAnchorSentence = (items: MemoryItem[]): string | null => {
  if (items.length === 0) return null;
  const fragments = items
    .map(renderAnchorFragment)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  if (fragments.length === 0) return null;
  if (fragments.length === 1) {
    return `我记得你上次${fragments[0]}。`;
  }
  return `我记得你上次${fragments[0]}，也${fragments[1]}。`;
};

const splitTradeoff = (value: string): [string, string] | null => {
  const normalized = normalizeText(value)
    .replace(/^在权衡/u, "")
    .replace(/^还没决定/u, "")
    .replace(/^还不确定/u, "")
    .replace(/^还没想好/u, "")
    .trim();
  if (!normalized.includes("还是")) return null;

  const [left, right] = normalized.split(/\s*还是/u, 2);
  const normalizedLeft = normalizeText((left ?? "").replace(/[，,：:]+$/u, "").trim());
  const normalizedRight = normalizeText((right ?? "").trim());
  if (!normalizedLeft || !normalizedRight) return null;
  return [normalizedLeft, normalizedRight];
};

const renderFollowUpLine = (item: MemoryItem | null): string => {
  if (!item) {
    return "如果你想，我们可以接着上次那个点；如果今天是新问题，也直接说。";
  }

  const tradeoff = splitTradeoff(item.content);
  if (tradeoff) {
    return `如果你愿意，我们可以接着看：${tradeoff[0]}，还是${tradeoff[1]}。如果今天是新问题，也直接说。`;
  }

  const content = normalizeText(item.content);
  switch (item.facet) {
    case "unfinished":
      return `如果你愿意，我们可以接着把${stripPrefix(content, "还没决定")}定下来；如果今天是新问题，也直接说。`;
    case "tension":
      return `如果你愿意，我们可以接着看${stripPrefix(content, "在权衡")}；如果今天是新问题，也直接说。`;
    case "goal":
      return `如果你愿意，我们可以继续推进${stripPrefix(content, "想先")}；如果今天是新问题，也直接说。`;
    default:
      return "如果你想，我们可以接着上次那个点；如果今天是新问题，也直接说。";
  }
};

export const mergeGreetingWithUnderstandingMemory = (input: {
  greetingText?: string;
  resolution?: UnderstandingGreetingResolution | null;
  item?: MemoryItem | null;
}): string | null => {
  const greetingText = asTrimmedString(input.greetingText);
  const resolution = input.resolution ?? null;
  const item = input.item ?? resolution?.item ?? null;
  if (!greetingText && !item) return null;
  if (!item) return greetingText || null;

  const anchorItems = resolution?.anchorItems ?? [];
  const followUpItem = resolution?.followUpItem ?? item;
  const leadLine = renderAnchorSentence(anchorItems) ?? `${renderLeadClause(item)}。`;
  const suffix = renderFollowUpLine(followUpItem);
  const memoryBlock = `欢迎回来。${leadLine}\n${suffix}`;

  if (!greetingText) {
    return memoryBlock;
  }
  return `${greetingText}\n\n${memoryBlock}`;
};
