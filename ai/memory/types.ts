export type MemoryOwnerType = "user" | "space" | "system";
export type MemoryVisibility = "private" | "shared" | "public";
export type MemorySubjectType = "user" | "agent" | "space" | "project" | "system";
export type MemoryKind = "episodic" | "semantic" | "procedural";
export type MemoryFacet =
  | "preference"
  | "tension"
  | "unfinished"
  | "goal"
  | "style";

export type MemorySourceKind =
  | "explicit-user-directive"
  | "agent-tool"
  | "inferred-understanding"
  | "dialog-learning";

export interface MemoryItem {
  id: string;
  ownerType: MemoryOwnerType;
  ownerId: string;
  visibility: MemoryVisibility;
  subjectType: MemorySubjectType;
  subjectId: string;
  kind: MemoryKind;
  content: string;
  createdAt: string;
  lastActivatedAt: string;
  activationCount: number;
  importance: number;
  confidence: number;
  tags?: string[];
  facet?: MemoryFacet;
  patternKey?: string;
  sourceKind?: MemorySourceKind;
  sourceDialogId?: string;
  sourceMessageId?: string;
  /**
   * 语义内容标识——跨实例去重用。
   *
   * 同一条记忆无论在本地还是远程生成，只要 ownerType/ownerId/
   * subjectType/subjectId/kind/content 相同，contentKey 就相同。
   * `mergeAndDedupUserData` 用它识别"同一条记忆"，避免重复。
   *
   * 格式：`mem-{sha256前16字符hex}`
   * 旧记录迁移前可能缺失，读取时按 undefined 处理（不影响已有去重逻辑）。
   */
  contentKey?: string;
}

export interface MemoryOwnerRef {
  ownerType: MemoryOwnerType;
  ownerId: string;
}

export interface MemorySubjectRef {
  subjectType: MemorySubjectType;
  subjectId: string;
}

export interface MemoryRuntimeResolution {
  selectedItems: MemoryItem[];
  promptBlock: string | null;
}
