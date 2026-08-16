import { touchMemoryItemsInDb } from "./storeShared";
import { buildMemoryOverlay } from "./overlay";
import { rankMemoryCandidates, type MemoryRankContext } from "./rank";
import { chooseMemoryOwners, loadMemoryCandidatesFromDb } from "./queryShared";
import { buildMemorySubjectsForAgent, resolveAgentMemoryPolicy } from "./policy";
import { EXPLICIT_REMEMBER_PREFIX_REGEX } from "./constants";
import type { MemoryRuntimeResolution } from "./types";

/** Below this confidence a memory is frozen out of retrieval entirely. */
export const COLD_STORAGE_CONFIDENCE = 0.3;

/**
 * Memory overlay 的软上限 token 预算（粗估）。
 * 防止记忆膨胀吃掉 context window；超出时按 kind 优先级截断。
 */
export const MEMORY_OVERLAY_TOKEN_BUDGET = 800;

const normalizeSelectedContent = (text: string): string =>
  text
    .trim()
    .replace(EXPLICIT_REMEMBER_PREFIX_REGEX, "")
    .replace(/[。！？!?]+$/u, "")
    .trim();

const STACK_TERMS = [
  "typescript",
  "javascript",
  "python",
  "rust",
  "go",
  "golang",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "php",
] as const;

const stackAliases: Record<string, string> = {
  golang: "go",
};

const normalizeStackTerm = (term: string): string => stackAliases[term] ?? term;

const stackTermsIn = (text: string): Set<string> => {
  const lower = text.toLowerCase();
  const terms = new Set<string>();
  for (const term of STACK_TERMS) {
    const pattern = term.length <= 2 ? new RegExp(`\\b${term}\\b`, "i") : new RegExp(term, "i");
    if (pattern.test(lower)) {
      terms.add(normalizeStackTerm(term));
    }
  }
  return terms;
};

const conflictsWithCurrentStack = (
  item: ReturnType<typeof rankMemoryCandidates>[number],
  userInput: string
): boolean => {
  const currentStacks = stackTermsIn(userInput);
  if (currentStacks.size === 0) return false;
  const memoryStacks = stackTermsIn(item.content);
  if (memoryStacks.size === 0) return false;
  for (const stack of memoryStacks) {
    if (!currentStacks.has(stack)) return true;
  }
  return false;
};

const INTERACTION_PREFERENCE_TERMS = [
  "回答偏好",
  "输出偏好",
  "回复偏好",
  "回答结构",
  "输出结构",
  "回复结构",
  "先给结论",
  "再列风险",
  "最后给证据",
  "语气",
  "风格",
  "称呼",
  "叫我",
] as const;

const isInteractionPreferenceMemory = (
  item: ReturnType<typeof rankMemoryCandidates>[number]
): boolean => {
  if (item.facet === "style") return true;
  const content = normalizeSelectedContent(item.content);
  return INTERACTION_PREFERENCE_TERMS.some((term) => content.includes(term));
};

const isOffCurrentPath = (item: ReturnType<typeof rankMemoryCandidates>[number], context?: MemoryRankContext): boolean => {
  const currentOwner = context?.currentOwner;
  const currentSubject = context?.currentSubject;
  if (
    currentSubject &&
    (item.subjectType === "project" || item.subjectType === "space") &&
    item.subjectType === currentSubject.subjectType &&
    item.subjectId !== currentSubject.subjectId
  ) {
    return true;
  }
  if (
    currentOwner?.ownerType === "space" &&
    item.ownerType === "user" &&
    (item.subjectType === "project" || item.subjectType === "space") &&
    item.subjectId !== currentOwner.ownerId
  ) {
    return true;
  }
  return false;
};

const selectRuntimeMemoryItems = (
  items: ReturnType<typeof rankMemoryCandidates>,
  context?: MemoryRankContext,
  userInput = ""
) => {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    // Cold storage: repeatedly corrected memories drop below the usage
    // threshold and stop being injected (record stays for the memory UI).
    if ((item.confidence ?? 0) < COLD_STORAGE_CONFIDENCE) return false;
    if (isOffCurrentPath(item, context)) return false;
    if (conflictsWithCurrentStack(item, userInput)) return false;
    const key = `${item.kind}:${normalizeSelectedContent(item.content).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const selected: typeof unique = [];
  const selectedIds = new Set<string>();
  const add = (item: typeof unique[number] | undefined) => {
    if (!item || selectedIds.has(item.id) || selected.length >= 4) return;
    selected.push(item);
    selectedIds.add(item.id);
  };

  add(
    unique.find(
      (item) =>
        context?.currentSubject &&
        item.subjectType === context.currentSubject.subjectType &&
        item.subjectId === context.currentSubject.subjectId
    )
  );
  add(unique.find(isInteractionPreferenceMemory));
  add(
    unique.find(
      (item) =>
        context?.currentOwner &&
        item.ownerType === context.currentOwner.ownerType &&
        item.ownerId === context.currentOwner.ownerId
    )
  );
  add(unique.find((item) => item.ownerType === "user"));
  add(unique.find((item) => item.ownerType === "space"));
  add(unique.find((item) => item.kind === "procedural"));
  for (const item of unique) {
    add(item);
  }
  return selected;
};

export const resolveMemoryRuntime = async (input: {
  db: any;
  userId?: string | null;
  spaceId?: string | null;
  agentKey: string;
  memorySubjectId?: string | null;
  userInput: string;
}): Promise<MemoryRuntimeResolution> => {
  const owners = chooseMemoryOwners({
    userId: input.userId,
    spaceId: input.spaceId,
  });
  if (owners.length === 0) {
    return { selectedItems: [], promptBlock: null };
  }

  const policy = resolveAgentMemoryPolicy({ agentKey: input.agentKey });
  const candidates = await loadMemoryCandidatesFromDb(input.db, {
    owners,
    subjects: buildMemorySubjectsForAgent({
      userId: input.userId,
      spaceId: input.spaceId,
      agentKey: input.agentKey,
      memorySubjectId: input.memorySubjectId,
      policy,
    }),
    kinds: ["episodic", "semantic", "procedural"],
    ownerLimit: 20,
    ownerFallback: policy.ownerFallback,
  });

  const rankContext: MemoryRankContext = {
    currentOwner: input.spaceId
      ? { ownerType: "space", ownerId: input.spaceId }
      : input.userId
        ? { ownerType: "user", ownerId: input.userId }
        : null,
    currentSubject: input.spaceId
      ? { subjectType: "space", subjectId: input.spaceId }
      : input.userId
        ? { subjectType: "user", subjectId: input.userId }
        : null,
  };
  const ranked = selectRuntimeMemoryItems(
    rankMemoryCandidates(candidates, input.userInput, rankContext),
    rankContext,
    input.userInput
  );
  if (ranked.length === 0) {
    return { selectedItems: [], promptBlock: null };
  }

  await touchMemoryItemsInDb(input.db, ranked);
  return {
    selectedItems: ranked,
    promptBlock: buildMemoryOverlay(ranked, { maxTokens: MEMORY_OVERLAY_TOKEN_BUDGET }),
  };
};
