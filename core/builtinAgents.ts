import { builtinAgentCatalogEntryById, builtinPlatformEntries } from "./builtinAgentCatalog";
import { publicAgentKey } from "./prefix";

export const SYSTEM_USER_ID = "system";

/**
 * Key / id 常量 —— 全部从 `builtinAgentCatalog.ts`（唯一真相源）派生。
 * 目录条目不存在时立即 throw，杜绝手抄漂移（历史上 PROPUB 错误即手抄所致）。
 */
const entry = (id: string) => {
  const e = builtinAgentCatalogEntryById(id);
  if (!e) throw new Error(`missing builtin agent catalog entry: ${id}`);
  return e;
};

export const BUILTIN_NOLO_AGENT_ID = entry("01NOLOAPPBLD000000019KCKT0").id;
export const BUILTIN_NOLO_AGENT_KEY = publicAgentKey(BUILTIN_NOLO_AGENT_ID);
export const BUILTIN_APP_BUILDER_AGENT_ID = entry("01APPBUILDER00000001YAII3I").id;
export const BUILTIN_APP_BUILDER_AGENT_KEY = publicAgentKey(BUILTIN_APP_BUILDER_AGENT_ID);
export const BUILTIN_ECOMMERCE_AGENT_ID = entry("01ECOMMERCEAG00000001PYQ2J").id;
export const BUILTIN_ECOMMERCE_AGENT_KEY = publicAgentKey(BUILTIN_ECOMMERCE_AGENT_ID);
export const BUILTIN_AGENT_CREATOR_AGENT_ID = entry("01NOLOAGENTCRT000000000001").id;
export const BUILTIN_AGENT_CREATOR_AGENT_KEY = publicAgentKey(BUILTIN_AGENT_CREATOR_AGENT_ID);
export const BUILTIN_FEEDBACK_AGENT_ID = entry("01NOLOFEEDBACKA000000000R2").id;
export const BUILTIN_FEEDBACK_AGENT_KEY = publicAgentKey(BUILTIN_FEEDBACK_AGENT_ID);
export const BUILTIN_CHROME_OPERATOR_AGENT_ID = entry("01CHROMEOPR000000000001").id;
export const BUILTIN_CHROME_OPERATOR_AGENT_KEY = publicAgentKey(BUILTIN_CHROME_OPERATOR_AGENT_ID);

/** 平台内置 6 个 agent 的 public key 列表（来自 catalog 的 builtin 组） */
export const BUILTIN_PLATFORM_AGENT_KEYS = builtinPlatformEntries().map(
  (e) => publicAgentKey(e.id),
);

const BUILTIN_PLATFORM_AGENT_KEY_SET = new Set<string>(BUILTIN_PLATFORM_AGENT_KEYS);

/**
 * Public quick-chat / image tier agents（来自 catalog 的 public 组）。
 * DeepSeek Flash 是确定性 seed id，不是历史别名 `agent-pub-deepseek-v4-flash`。
 */
export const PUBLIC_DEEPSEEK_V4_FLASH_AGENT_ID = entry("01DSV4FLASHPB00000000JFPFD").id;
export const PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY = publicAgentKey(PUBLIC_DEEPSEEK_V4_FLASH_AGENT_ID);
export const PUBLIC_DEEPSEEK_V4_PRO_AGENT_ID = entry("01DSV4PRONPB00000001VIR3EK").id;
export const PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY = publicAgentKey(PUBLIC_DEEPSEEK_V4_PRO_AGENT_ID);
export const PUBLIC_KIMI_K26_IMAGE_AGENT_ID = entry("01KIMIK26OLLAMA0000000001").id;
export const PUBLIC_KIMI_K26_IMAGE_AGENT_KEY = publicAgentKey(PUBLIC_KIMI_K26_IMAGE_AGENT_ID);
export const PUBLIC_GPT_IMAGE_2_GENERATOR_AGENT_ID = entry("01GPTIMG2GEN00000000SSEBOS").id;
export const PUBLIC_GPT_IMAGE_2_GENERATOR_AGENT_KEY = publicAgentKey(PUBLIC_GPT_IMAGE_2_GENERATOR_AGENT_ID);
export const PUBLIC_GPT_IMAGE_2_EDITOR_AGENT_ID = entry("01GPTIMG2EDT00000001R4R4H4").id;
export const PUBLIC_GPT_IMAGE_2_EDITOR_AGENT_KEY = publicAgentKey(PUBLIC_GPT_IMAGE_2_EDITOR_AGENT_ID);
export const PUBLIC_GPT_IMAGE_2_CONTINUOUS_AGENT_ID = entry("01GPTIMG2CNT00000000USKZFO").id;
export const PUBLIC_GPT_IMAGE_2_CONTINUOUS_AGENT_KEY = publicAgentKey(PUBLIC_GPT_IMAGE_2_CONTINUOUS_AGENT_ID);
export const PUBLIC_NANO_BANANA_2_LITE_AGENT_ID = entry("01NB2LITEGEN00000001XE1MNO").id;
export const PUBLIC_NANO_BANANA_2_LITE_AGENT_KEY = publicAgentKey(PUBLIC_NANO_BANANA_2_LITE_AGENT_ID);

/**
 * Default Code Planner executor candidate pool.
 * No fixed roles, no scoring — just a simple allowlist-shaped key list.
 * Runtime hard allowlist wiring is Phase 1 (`runtimeContext.allowedChildAgentKeys`).
 */
export const DEFAULT_CODE_PLANNER_EXECUTOR_CANDIDATE_KEYS = [
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
] as const;

/**
 * Quick-chat 档位 agent：执行真相在代码里（agent-runtime/builtinPlatformAgentConfigs），
 * 对应的 agent-pub-* 记录按设计可以不存在（runtime fallback 合成配置）。
 */
export const PLATFORM_TIER_AGENT_KEYS = [
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_KIMI_K26_IMAGE_AGENT_KEY,
] as const;

/**
 * 系统内置可信平台 agent（信任边界判定，与 PLATFORM_TIER_AGENT_KEYS 的 quick-chat
 * 档位语义正交）。
 *
 * 背景：pro/flash 的 runtime fallback 合成配置只有 provider/model（无 tools/prompt），
 * 而它们在 CLI / 服务端 agent-run 的工具面解析里会被当作普通 public agent
 * （agent-pub-* 不注入默认工具），导致这些系统内置 agent 只能纯回话、无法跑
 * workspace 工具 loop——与其宣称的 agentic 能力不符。
 *
 * 处理：此集合内的 agent key 在工具面解析时获得与 @nolo 一致的只读 workspace 工具
 * 注入（DEFAULT_PRIVATE_NOLO_WORKSPACE_TOOLS；无 execShell / 写文件，安全边界不变）。
 */
export const SYSTEM_BUILTIN_TRUSTED_AGENT_KEYS = [
  PUBLIC_DEEPSEEK_V4_FLASH_AGENT_KEY,
  PUBLIC_DEEPSEEK_V4_PRO_AGENT_KEY,
] as const;

const SYSTEM_BUILTIN_TRUSTED_AGENT_KEY_SET = new Set<string>(
  SYSTEM_BUILTIN_TRUSTED_AGENT_KEYS,
);

export const isSystemBuiltinTrustedAgentKey = (
  key: string | undefined | null,
): boolean =>
  typeof key === "string" && SYSTEM_BUILTIN_TRUSTED_AGENT_KEY_SET.has(key);

export const isBuiltinPlatformAgentKey = (key: string | undefined | null): boolean =>
  typeof key === "string" && BUILTIN_PLATFORM_AGENT_KEY_SET.has(key);

