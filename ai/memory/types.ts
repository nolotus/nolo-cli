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
  | "inferred-understanding";

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
