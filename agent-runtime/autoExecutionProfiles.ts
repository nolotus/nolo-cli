import {
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
} from "../core/builtinAgents";
import type { AgentRuntimeAgentConfig } from "./hostAdapter";

export type AutoExecutionTier = "flash" | "balanced" | "quality" | "image";

/** Stable relationship-memory subject for the product-level auto assistant. */
export const AUTO_ASSISTANT_MEMORY_SUBJECT_ID = "builtin:auto";

export type AutoExecutionProfile = AgentRuntimeAgentConfig & {
  id: string;
  tier: AutoExecutionTier;
  /** Compatibility identifier for runtime APIs that still accept an agent key. */
  legacyAgentKey: string;
};

const createProfile = (input: {
  id: string;
  tier: AutoExecutionTier;
  legacyAgentKey: string;
  name: string;
  model: string;
}): AutoExecutionProfile => ({
  id: input.id,
  tier: input.tier,
  legacyAgentKey: input.legacyAgentKey,
  key: input.legacyAgentKey,
  name: input.name,
  provider: "nolo",
  model: input.model,
  apiSource: "platform",
  useServerProxy: true,
  rawRecord: {
    dbKey: input.legacyAgentKey,
    isPublic: true,
    provider: "nolo",
    model: input.model,
    apiSource: "platform",
    useServerProxy: true,
  },
});

const FLASH_PROFILE = createProfile({
  id: "builtin:auto:deepseek-v4-flash",
  tier: "flash",
  legacyAgentKey: PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  name: "DeepSeek V4 Flash",
  model: "deepseek-v4-flash",
});

const IMAGE_PROFILE = createProfile({
  id: "builtin:auto:kimi-k2.6",
  tier: "image",
  legacyAgentKey: PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
  name: "Kimi K2.6",
  model: "kimi-k2.6",
});

/**
 * Code-owned execution truth for dialogs in auto mode. These profiles do not
 * require a persisted Agent entity. Balanced/quality intentionally share the
 * current Flash runtime profile until product routing changes.
 */
export const AUTO_EXECUTION_PROFILES: Readonly<
  Record<AutoExecutionTier, AutoExecutionProfile>
> = {
  flash: FLASH_PROFILE,
  balanced: { ...FLASH_PROFILE, tier: "balanced" },
  quality: { ...FLASH_PROFILE, tier: "quality" },
  image: IMAGE_PROFILE,
};

export const DEFAULT_AUTO_EXECUTION_TIER: AutoExecutionTier = "flash";
export const DEFAULT_AUTO_EXECUTION_PROFILE =
  AUTO_EXECUTION_PROFILES[DEFAULT_AUTO_EXECUTION_TIER];

export const resolveAutoExecutionProfile = (
  tier: AutoExecutionTier | null | undefined,
): AutoExecutionProfile =>
  AUTO_EXECUTION_PROFILES[tier ?? DEFAULT_AUTO_EXECUTION_TIER] ??
  DEFAULT_AUTO_EXECUTION_PROFILE;
