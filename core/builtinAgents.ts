export const BUILTIN_NOLO_AGENT_KEY = "agent-pub-01NOLOAPPBLD000000019KCKT0";
export const BUILTIN_APP_BUILDER_AGENT_KEY =
  "agent-pub-01APPBUILDER00000001YAII3I";
export const BUILTIN_ECOMMERCE_AGENT_KEY =
  "agent-pub-01ECOMMERCEAG00000001PYQ2J";
export const BUILTIN_AGENT_CREATOR_AGENT_KEY =
  "agent-pub-01NOLOAGENTCRT000000000001";
export const BUILTIN_FEEDBACK_AGENT_KEY =
  "agent-pub-01NOLOFEEDBACKA000000000R2";
export const BUILTIN_CHROME_OPERATOR_AGENT_KEY =
  "agent-pub-01CHROMEOPR000000000001";
export const BUILTIN_TASK_ORCHESTRATOR_AGENT_KEY =
  "agent-pub-01NOLOTASKORCH000000000001";
export const BUILTIN_RESEARCH_AGENT_KEY =
  "agent-pub-01NOLORESEARCH000000000001";
export const BUILTIN_CODE_PLANNER_AGENT_KEY =
  "agent-pub-01NOLOCODEPLAN000000000001";

export const BUILTIN_NOLO_AGENT_ID = "01NOLOAPPBLD000000019KCKT0";
export const BUILTIN_APP_BUILDER_AGENT_ID = "01APPBUILDER00000001YAII3I";
export const BUILTIN_ECOMMERCE_AGENT_ID = "01ECOMMERCEAG00000001PYQ2J";
export const BUILTIN_AGENT_CREATOR_AGENT_ID = "01NOLOAGENTCRT000000000001";
export const BUILTIN_FEEDBACK_AGENT_ID = "01NOLOFEEDBACKA000000000R2";
export const BUILTIN_CHROME_OPERATOR_AGENT_ID = "01CHROMEOPR000000000001";
export const BUILTIN_TASK_ORCHESTRATOR_AGENT_ID = "01NOLOTASKORCH000000000001";
export const BUILTIN_RESEARCH_AGENT_ID = "01NOLORESEARCH000000000001";
export const BUILTIN_CODE_PLANNER_AGENT_ID = "01NOLOCODEPLAN000000000001";

/**
 * Shared-space public catalog agents used as Code Planner default executor candidates.
 * IDs come from scripts/createSpaceAgents.ts seeds (DeepSeek Flash is the deterministic
 * seed id, not the historical alias `agent-pub-deepseek-v4-flash`).
 */
export const PUBLIC_DEEPSEEK_V4_FLASH_AGENT_ID = "01DSV4FLASHPB00000000JFPFD";
export const PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY =
  `agent-pub-${PUBLIC_DEEPSEEK_V4_FLASH_AGENT_ID}`;
export const PUBLIC_DEEPSEEK_V4_PRO_AGENT_ID = "01DSV4PROPUB00000001A9OLZN";
export const PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY =
  `agent-pub-${PUBLIC_DEEPSEEK_V4_PRO_AGENT_ID}`;

export const PUBLIC_KIMI_K27_CODING_AGENT_ID = "01KIMIK27CODEOL000000001";
export const PUBLIC_KIMI_K27_CODING_AGENT_KEY =
  `agent-pub-${PUBLIC_KIMI_K27_CODING_AGENT_ID}`;

export const PUBLIC_GLM_52_AGENT_ID = "01GLM52CHAT00000000001U721";
export const PUBLIC_GLM_52_AGENT_KEY = `agent-pub-${PUBLIC_GLM_52_AGENT_ID}`;

/**
 * Default Code Planner executor candidate pool.
 * No fixed roles, no scoring — just a simple allowlist-shaped key list.
 * Runtime hard allowlist wiring is Phase 1 (`runtimeContext.allowedChildAgentKeys`).
 */
export const DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS = [
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_KIMI_K27_CODING_AGENT_KEY,
  PUBLIC_GLM_52_AGENT_KEY,
] as const;

export const BUILTIN_PLATFORM_AGENT_KEYS = [
  BUILTIN_NOLO_AGENT_KEY,
  BUILTIN_APP_BUILDER_AGENT_KEY,
  BUILTIN_ECOMMERCE_AGENT_KEY,
  BUILTIN_AGENT_CREATOR_AGENT_KEY,
  BUILTIN_FEEDBACK_AGENT_KEY,
  BUILTIN_CHROME_OPERATOR_AGENT_KEY,
  BUILTIN_TASK_ORCHESTRATOR_AGENT_KEY,
  BUILTIN_RESEARCH_AGENT_KEY,
  BUILTIN_CODE_PLANNER_AGENT_KEY,
] as const;

const BUILTIN_PLATFORM_AGENT_KEY_SET = new Set<string>(BUILTIN_PLATFORM_AGENT_KEYS);

export const isBuiltinPlatformAgentRecord = (agent: {
  dbKey?: string | null;
  id?: string | null;
}): boolean => {
  const dbKey = typeof agent?.dbKey === "string" ? agent.dbKey : "";
  if (dbKey && BUILTIN_PLATFORM_AGENT_KEY_SET.has(dbKey)) return true;

  const id = typeof agent?.id === "string" ? agent.id : "";
  if (!id) return false;

  return BUILTIN_PLATFORM_AGENT_KEYS.some((key) => key.endsWith(id));
};
