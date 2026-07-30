import { buildAgentSubjectTarget, resolveScopedMemoryTargets, type MemoryScope } from "./scope";
import { createMemoryItem, writeMemoryItemWithIndexesToDb } from "./store";
import { loadOwnerItemsFromDb } from "./queryShared";
import type {
  MemoryItem,
  MemoryKind,
  MemoryOwnerType,
  MemorySubjectType,
  MemoryVisibility,
} from "./types";

export type RememberMemoryScope = MemoryScope;

export type RememberMemorySource = "user-directive" | "agent-inferred";

export interface RememberMemoryInput {
  db?: any;
  userId?: string | null;
  spaceId?: string | null;
  dialogId?: string | null;
  content: string;
  scope?: RememberMemoryScope;
  kind?: MemoryKind;
  /**
   * 记忆来源——决定初始置信度。
   * - "user-directive"：用户明确要求记住（如"请记住 X"）→ 高置信
   * - "agent-inferred"：agent 推测值得记（如 rememberMemory tool 调用）→ 中低置信
   * 默认 "agent-inferred"（向后兼容：现有调用方不传 source 时保持旧行为）。
   */
  source?: RememberMemorySource;
  /**
   * Optional agent subject key. When provided, the resolved owner target's
   * subject is rewritten to { subjectType: "agent", subjectId: agentKey } so
   * the memory shows up in that agent's "这个 Agent 记得你什么" tab.
   */
  agentKey?: string | null;
}

export interface RememberMemoryResult {
  success: true;
  content: string;
  requestedScope: RememberMemoryScope;
  savedItems: MemoryItem[];
  resolvedScopes: Array<{
    ownerType: MemoryOwnerType;
    ownerId: string;
    subjectType: MemorySubjectType;
    subjectId: string;
    visibility: MemoryVisibility;
  }>;
}

const MEMORY_KINDS = new Set<MemoryKind>(["episodic", "semantic", "procedural"]);

export const rememberMemory = async (
  input: RememberMemoryInput
): Promise<RememberMemoryResult> => {
  const content = input.content.trim();
  if (!content) {
    throw new Error("rememberMemory: content is required");
  }

  const scope = input.scope ?? "auto";
  let targets: ReturnType<typeof resolveScopedMemoryTargets>;
  try {
    targets = resolveScopedMemoryTargets({
      userId: input.userId,
      spaceId: input.spaceId,
      scope,
      fallbackToUserForMissingSpace: true,
    });
  } catch (error) {
    if (scope === "user") {
      throw new Error("rememberMemory: user scope requires userId");
    }
    if (scope === "space") {
      throw new Error("rememberMemory: space scope requires spaceId");
    }
    throw error;
  }
  if (targets.length === 0) {
    throw new Error("rememberMemory: no valid owner scope found");
  }

  const getDefaultDb = async () => (await import("../../database-engine/db")).default;
  const db = input.db ?? await getDefaultDb();
  const kind = input.kind ?? "episodic";
  if (!MEMORY_KINDS.has(kind)) {
    throw new Error("rememberMemory: kind must be episodic, semantic, or procedural");
  }
  const agentKey = input.agentKey?.trim() || null;
  const source = input.source ?? "agent-inferred";

  // 置信度按来源区分（§3.2 判别标准）：
  // user-directive（用户明确要求记住）→ 高置信，可直接影响行为
  // agent-inferred（agent 推测）→ 中低置信，只在恰好相关时轻提
  // 注意：COLD_STORAGE_CONFIDENCE=0.3，纠正惩罚=-0.2。
  // agent-inferred episodic 设 0.6 → 一次纠正降到 0.4（仍可用），两次纠正降到 0.2（冷藏）。
  // 不设 0.5 是因为一次纠正就会到 0.3 边缘——太脆弱。
  const baseConfidence =
    source === "user-directive"
      ? kind === "procedural" ? 0.88 : 0.85
      : kind === "procedural" ? 0.68 : 0.6;

  const savedItems = await Promise.all(
    targets.map(async (target) => {
      const subject = agentKey
        ? buildAgentSubjectTarget(target, agentKey)
        : target;

      // 去重：查同 owner + 同 content + 同 subject 的已有记忆（Bug 2 修复）
      // 找到 → 更新激活时间 + 提升计数 + 取较高 confidence（不新建）
      // 没找到 → 新建
      const existing = await findExistingMemoryByContent(db, target, content, kind, agentKey);
      if (existing) {
        const updated: MemoryItem = {
          ...existing,
          lastActivatedAt: new Date().toISOString(),
          activationCount: (existing.activationCount ?? 0) + 1,
          confidence: Math.max(existing.confidence ?? 0, baseConfidence),
          sourceDialogId: input.dialogId ?? existing.sourceDialogId,
        };
        await writeMemoryItemWithIndexesToDb(db, updated);
        return updated;
      }

      const item = createMemoryItem({
        ownerType: target.ownerType,
        ownerId: target.ownerId,
        visibility: target.visibility,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        kind,
        content,
        importance: kind === "procedural" ? 0.88 : target.ownerType === "user" ? 0.82 : 0.76,
        confidence: baseConfidence,
        tags:
          target.ownerType === "user"
            ? ["agent-remembered", ...(kind === "procedural" ? ["procedural-memory"] : [])]
            : ["agent-remembered", "space-context", ...(kind === "procedural" ? ["procedural-memory"] : [])],
        patternKey: kind === "procedural" ? "procedural-runbook" : "agent-remember",
        sourceDialogId: input.dialogId ?? undefined,
      });
      await writeMemoryItemWithIndexesToDb(db, item);
      return item;
    }),
  );

  return {
    success: true,
    content,
    requestedScope: scope,
    savedItems,
    resolvedScopes: targets.map((target) => ({
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      subjectType: target.subjectType,
      subjectId: target.subjectId,
      visibility: target.visibility,
    })),
  };
};

/**
 * 查同 owner + 同 content + 同 kind 的已有记忆（去重用）。
 * 当 agentKey 存在时，额外要求 subject 匹配——避免同一用户下
 * 不同 agent 写相同 content 被误合并（它们应是独立的 subject=agent 记忆）。
 * 只匹配 content 精确相等——不做模糊匹配，避免误合并语义相近但不同的记忆。
 */
async function findExistingMemoryByContent(
  db: any,
  target: { ownerType: MemoryOwnerType; ownerId: string },
  content: string,
  kind: MemoryKind,
  agentKey: string | null,
): Promise<MemoryItem | null> {
  const items = await loadOwnerItemsFromDb(db, target, 200);
  return items.find(
    (item) =>
      item.content === content &&
      item.kind === kind &&
      // agentKey 存在时要求 subject 匹配，避免跨 agent 误合并
      (agentKey
        ? item.subjectType === "agent" && item.subjectId === agentKey
        : item.subjectType === target.ownerType && item.subjectId === target.ownerId),
  ) ?? null;
}
