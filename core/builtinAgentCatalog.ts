/**
 * Platform builtin agent catalog — 单一真相源（运行时字段）。
 *
 * 覆盖所有代码层创建的「平台内置 / 公开」agent 的运行时字段：
 * id、name、provider、model、apiSource、useServerProxy 与图片工作流字段。
 *
 * 派生关系（手抄全部消失）：
 * - `packages/core/builtinAgents.ts` 的 key/id 常量 → 从本目录派生
 * - `packages/agent-runtime/builtinPlatformAgentConfigs.ts` 的运行时兜底表 → 从
 *   `runtimeFallback: true` 条目派生（quick-chat 档位 + 图片档，记录缺失时合成配置）
 * - `scripts/updatePlazaModels.ts` 的 TARGETS → 从本目录派生
 *
 * 内容字段（introduction / greeting / prompt / tools / tags / 价格）留在
 * `scripts/createSpaceAgents.ts` 的 seed 定义（写库用，运行时不需要）；
 * seed 与目录的一致性由 `createSpaceAgents.source.test.ts` 的断言锁住。
 *
 * 模型换代流程（如 GLM 5.2 → 5.3）：只改本目录对应条目的 `model`（id 保持
 * 稳定，用户收藏不失效）→ 兜底表 / 常量 / sync TARGETS 自动跟随 → 跑
 * `bun scripts/updatePlazaModels.ts` 批量升级生产记录。注意 seed 内容层
 * （scripts/createSpaceAgents.ts）的 provider/model 需同步改，一致性测试会
 * 提示（见 createSpaceAgents.source.test.ts）。
 *
 * 两个布尔维度：`group` 表达「builtin 平台内置 6 个 vs public 广场公开」，
 * `runtimeFallback` 表达「运行时兜底需要与否」——正交，可独立取值（如
 * @nolo 是 builtin 组但需要兜底）。agent key 前缀构造/解析统一走
 * `core/prefix.ts`（publicAgentKey / parsePublicAgentId）。
 */

export type BuiltinAgentCatalogEntry = {
  /** 稳定 id（不随模型版本变化） */
  id: string;
  name: string;
  provider: string;
  model: string;
  apiSource?: string;
  useServerProxy?: boolean;
  /** builtin = 平台内置 6 个（BUILTIN_PLATFORM_AGENT_KEYS）；public = 广场公开 */
  group: "builtin" | "public";
  /**
   * true = 需要运行时兜底（quick-chat 档位 / 图片档 / @nolo 引导）。
   * 记录在本地/远端缺失时，runtime 用目录合成配置，保证进站即用。
   */
  runtimeFallback?: boolean;
  // 图片工作流字段（与 createSpaceAgents 的 imageWorkflow/imageConfig 对齐）
  hasImageOutput?: boolean;
  imageModel?: string;
  imageWorkflow?: "generate" | "edit" | "continuous";
  imageConfig?: { enabled: boolean };
};

export const BUILTIN_AGENT_CATALOG: BuiltinAgentCatalogEntry[] = [
  // ── 平台内置 6 个（builtinAgents BUILTIN_*）──
  {
    id: "01NOLOAPPBLD000000019KCKT0",
    group: "builtin",
    name: "nolo",
    provider: "nolo",
    model: "deepseek-v4-flash",
    runtimeFallback: true,
  },
  {
    id: "01APPBUILDER00000001YAII3I",
    group: "builtin",
    name: "应用构建助手",
    provider: "nolo",
    model: "deepseek-v4-flash",
  },
  {
    id: "01ECOMMERCEAG00000001PYQ2J",
    group: "builtin",
    name: "电商商品参数助手",
    provider: "openai",
    model: "gpt-5.6-luna",
  },
  {
    id: "01NOLOAGENTCRT000000000001",
    group: "builtin",
    name: "AI 创建助手",
    provider: "nolo",
    model: "deepseek-v4-flash",
  },
  {
    id: "01NOLOFEEDBACKA000000000R2",
    group: "builtin",
    name: "反馈入口",
    provider: "nolo",
    model: "deepseek-v4-flash",
  },
  {
    id: "01CHROMEOPR000000000001",
    group: "builtin",
    name: "Chrome 操作员",
    provider: "nolo",
    model: "deepseek-v4-flash",
  },
  // ── quick-chat 档位 / 图片档 public（runtimeFallback）──
  {
    id: "01DSV4FLASHPB00000000JFPFD",
    group: "public",
    name: "DeepSeek V4 Flash",
    provider: "nolo",
    model: "deepseek-v4-flash",
    runtimeFallback: true,
  },
  {
    id: "01DSV4PRONPB00000001VIR3EK",
    group: "public",
    name: "DeepSeek V4 Pro",
    provider: "nolo",
    model: "deepseek-v4-pro",
    runtimeFallback: true,
  },
  {
    id: "01KIMIK26OLLAMA0000000001",
    group: "public",
    name: "Kimi K2.6",
    provider: "nolo",
    model: "kimi-k2.6",
    runtimeFallback: true,
  },
  {
    id: "01GPTIMG2GEN00000000SSEBOS",
    group: "public",
    name: "GPT Image 2 图片生成器",
    provider: "openai",
    model: "gpt-5.6-luna",
    runtimeFallback: true,
    hasImageOutput: true,
    imageModel: "gpt-image-2",
    imageWorkflow: "generate",
    imageConfig: { enabled: true },
  },
  {
    id: "01GPTIMG2EDT00000001R4R4H4",
    group: "public",
    name: "GPT Image 2 图片编辑器",
    provider: "openai",
    model: "gpt-5.6-luna",
    runtimeFallback: true,
    hasImageOutput: true,
    imageModel: "gpt-image-2",
    imageWorkflow: "edit",
    imageConfig: { enabled: true },
  },
  {
    id: "01GPTIMG2CNT00000000USKZFO",
    group: "public",
    name: "GPT Image 2 连续创作助手",
    provider: "openai",
    model: "gpt-5.6-luna",
    runtimeFallback: true,
    hasImageOutput: true,
    imageModel: "gpt-image-2",
    imageWorkflow: "continuous",
    imageConfig: { enabled: true },
  },
  {
    id: "01NB2LITEGEN00000001XE1MNO",
    group: "public",
    name: "Nano Banana 2 Lite 文生图",
    provider: "google",
    model: "gemini-3.1-flash-lite-image",
    runtimeFallback: true,
    hasImageOutput: true,
  },
];

const CATALOG_BY_ID = new Map(BUILTIN_AGENT_CATALOG.map((e) => [e.id, e]));

export function builtinAgentCatalogEntryById(
  id: string | undefined | null,
): BuiltinAgentCatalogEntry | undefined {
  if (!id) return undefined;
  return CATALOG_BY_ID.get(id);
}

/** 所有需要运行时兜底的目录条目（quick-chat 档位 + 图片档 + @nolo） */
export function builtinRuntimeFallbackEntries(): BuiltinAgentCatalogEntry[] {
  return BUILTIN_AGENT_CATALOG.filter((e) => e.runtimeFallback === true);
}

/** 平台内置 6 个（BUILTIN_PLATFORM_AGENT_KEYS 的真相源） */
export function builtinPlatformEntries(): BuiltinAgentCatalogEntry[] {
  return BUILTIN_AGENT_CATALOG.filter((e) => e.group === "builtin");
}
