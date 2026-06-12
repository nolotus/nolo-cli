export type TonePreset =
  | "default"
  | "professional"
  | "friendly"
  | "direct"
  | "pragmatic";

export type ToneResolutionMode = "agent_first" | "user_first" | "blend";

export type KnowledgeCaptureLevel = 1 | 2 | 3 | 4;
export type SpaceContextLevel = 1 | 2 | 3 | 4;

export type SelfEvolutionMode =
  | "none"
  | "knowledge_only"
  | "prompt_and_refs"
  | "full";

export interface AgentBasePolicy {
  version: 1;
  tone?: {
    preset?: TonePreset;
    resolutionMode?: ToneResolutionMode;
  };
  knowledgeCaptureMaxLevel: KnowledgeCaptureLevel;
  spaceContextMaxLevel: SpaceContextLevel;
  selfEvolutionMode: SelfEvolutionMode;
}

export interface UserPreferenceProfile {
  version: 1;
  tone?: {
    preset?: TonePreset;
  };
  knowledgeCaptureLevel: KnowledgeCaptureLevel;
  spaceContextLevel: SpaceContextLevel;
}

export interface DialogPolicyState {
  autoKnowledgeCaptureCount?: number;
  autoSpaceReadCount?: number;
  updatedAt?: number;
}

export const DEFAULT_AGENT_BASE_POLICY: AgentBasePolicy = {
  version: 1,
  tone: {
    preset: "default",
    resolutionMode: "blend",
  },
  knowledgeCaptureMaxLevel: 4,
  spaceContextMaxLevel: 4,
  selfEvolutionMode: "knowledge_only",
};

export const DEFAULT_USER_PREFERENCE_PROFILE: UserPreferenceProfile = {
  version: 1,
  tone: {
    preset: "default",
  },
  knowledgeCaptureLevel: 2,
  spaceContextLevel: 3,
};

