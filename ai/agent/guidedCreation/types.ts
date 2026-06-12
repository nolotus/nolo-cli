import type { ReferenceItem } from "../../../app/types";

export type GuidedAgentCapabilityId =
  | "webSearch"
  | "docs"
  | "tables"
  | "agents"
  | "apps";

export type GuidedAgentReferenceChoice = ReferenceItem & {
  selected: boolean;
  reason?: string;
};

export type GuidedAgentDraft = {
  name: string;
  introduction: string;
  prompt: string;
  promptSummary: string;
  provider: string;
  model: string;
  isPublic: boolean;
  capabilityIds: GuidedAgentCapabilityId[];
  toolIds: string[];
  references: GuidedAgentReferenceChoice[];
  tags: string[];
  unresolved: string[];
};

export type GuidedAgentAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type GuidedAgentValidationResult =
  | { ok: true }
  | { ok: false; missing: string[] };
