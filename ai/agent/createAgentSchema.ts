// 路径: ai/agent/createAgentSchema.ts
//
// valibot 版（原 zod 版迁移）：函数式 pipe 写法，Standard Schema 兼容。
// 与自研 useForm（packages/form/useForm.ts）配套：schema["~standard"].validate(values)。

import {
  object,
  looseObject,
  string,
  number,
  boolean,
  picklist,
  literal,
  union,
  array,
  record,
  optional,
  nullable,
  nullish,
  transform,
  pipe,
  trim,
  minLength,
  maxLength,
  minValue,
  maxValue,
  check,
  forward,
  type InferOutput,
} from "valibot";
import { ReferenceItem } from "../../app/types"; // 确保 app/types 里有 ReferenceItem 定义
import { isRecord } from "../../core/isRecord";
import { isLoopbackUrl } from "../../core/localOrigins";
import { TFunction } from "i18next";
import { CLI_PROVIDER_VALUES } from "./cliProviders";

// Re-export form-facing CLI list from the single browser-safe authority.
export { CLI_PROVIDER_VALUES, type CliProvider, type CliProviderValue } from "./cliProviders";

// --- 常量 ---
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_TOP_P = 1;
export const DEFAULT_FREQUENCY_PENALTY = 0.0;
export const DEFAULT_PRESENCE_PENALTY = 0.0;
export const DEFAULT_MAX_TOKENS = 4096;
/**
 * max_tokens 的共享上限。schema 的 `.max()` 与 UI 滑块的 `max` 必须同时引用
 * 这个常量，避免出现「界面够不到 / 校验够得到」或反向的不一致。
 * 取 500000（往高统一）：往低统一会让已经存过更大值的 agent 在编辑时校验失败。
 */
export const MAX_TOKENS_LIMIT = 500000;
export const DEFAULT_REASONING_EFFORT = "medium";

/**
 * 推理强度选项，覆盖 OpenAI 完整的 reasoning_effort 枚举。
 * 不同 provider 实际支持的子集不同，发送链路负责做 provider-aware clamp。
 *
 * OpenAI:      none / minimal / low / medium / high / xhigh / max（全支持）
 * xAI Grok:    low / medium / high（默认 high，不可关闭推理）
 * DeepSeek:    none / low / medium / high（OpenAI 兼容格式）
 * Anthropic:   不走 reasoning_effort，走 thinking.budget_tokens（见 enableThinking + thinkingBudget）
 * Google:      不走 reasoning_effort，走 thinking_config（见 enableThinking + thinkingBudget）
 * Kimi/Moonshot: low / medium / high（xhigh/max 被 clamp 到 high）
 */
export const REASONING_EFFORT_OPTIONS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_OPTIONS)[number];

/**
 * 各 provider 实际支持的 reasoning_effort 值（精确集合，非上限）。
 * 用于 UI 动态过滤和发送链路 clamp。
 *
 * OpenAI:           none / minimal / low / medium / high / xhigh / max
 * DeepSeek V4:      low / high / max（跳过 medium、xhigh）
 * Kimi K3/Moonshot: none / low / high / max（可关思考；默认 max；跳过 medium、xhigh）
 *                   注意：kimi-code proxy 仍会把 max→high（上游 API 不认 max），见 enhanceKimiCodeBody
 * xAI Grok:         low / medium / high（默认 high，不可关闭）
 * Anthropic/Google: 不走 reasoning_effort 通道
 */
export const PROVIDER_REASONING_EFFORT_VALUES: Record<string, ReasoningEffort[]> = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  deepseek: ["low", "high", "max"],
  // nolo (Ollama Cloud) 支持 DeepSeek/Kimi/GLM 等 thinking 模型，
  // reasoning_effort 通过 OpenAI 兼容端点透传到 Ollama Cloud。
  nolo: ["low", "high", "max"],
  xai: ["low", "medium", "high"],
  grok: ["low", "medium", "high"],
  // none：关闭思考；必须保留，否则上游 clamp 会把 none 抬成 low，
  // kimi-code proxy 的 none/off → thinking.disabled 分支永远接不到。
  kimi: ["none", "low", "high", "max"],
  moonshot: ["none", "low", "high", "max"],
  // Qwen 用 enable_thinking (bool) 而非 reasoning_effort → 隐藏下拉
  qwen: [],
  // MiniMax M3: 接受这些值但所有非 none 效果相同
  minimax: ["none", "low", "medium", "high"],
  // Cursor: 推理强度在模型名后缀 (如 -high)，不走独立参数
  cursor: [],
  // MiMo: 保守默认
  mimo: ["low", "medium", "high"],
};

/**
 * 根据 provider 返回 UI 中可选的 reasoning_effort 选项列表。
 * 用于下拉框动态过滤：只显示当前 provider 实际支持的值。
 *
 * - anthropic/google → 空数组（走 thinking 机制，不用 reasoning_effort）
 * - xai/grok → low / medium / high
 * - 未知 provider → low / medium / high（保守默认）
 */
export function getAvailableReasoningEfforts(
  provider: string | null | undefined,
): ReasoningEffort[] {
  const p = (provider ?? "").toLowerCase();
  if (p === "anthropic" || p === "google") return [];
  return PROVIDER_REASONING_EFFORT_VALUES[p] ?? ["low", "medium", "high"];
}

const greetingMenuItemSchema = object({
  id: pipe(string(), minLength(1)),
  label: pipe(string(), minLength(1)),
  userMessage: optional(string()),
});

const greetingConfigSchema = object({
  text: optional(pipe(string(), trim())),
  menu: optional(array(greetingMenuItemSchema)),
});

const runtimeToolPolicySchema = looseObject({
  version: optional(literal(1)),
  agentTools: optional(array(string())),
  runtimeTools: optional(array(string())),
  workspace: optional(
    object({
      mode: optional(picklist(["none", "current", "lease"] as const)),
      writableRoots: optional(array(string())),
      cwd: optional(string()),
    }),
  ),
  shell: optional(record(string(), string())),
  isolation: optional(record(string(), string())),
  git: optional(record(string(), string())),
  budget: optional(record(string(), string())),
  audit: optional(record(string(), string())),
});

export function isLocalCustomProviderUrl(value: unknown): boolean {
  return isLoopbackUrl(value);
}

/** Hosted exec is allowed when policy includes execShell or lease workspace. */
export function runtimePolicyAllowsHostedExec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const policy = value as {
    runtimeTools?: unknown;
    workspace?: { mode?: unknown };
  };
  return (
    (Array.isArray(policy.runtimeTools) &&
      policy.runtimeTools.includes("execShell")) ||
    policy.workspace?.mode === "lease"
  );
}

const referenceItemSchema = pipe(
  object({
    dbKey: string(),
    title: string(),
    type: picklist(["knowledge", "instruction", "page"] as const),
  }),
  transform((data) => ({
    ...data,
    type: data.type === "page" ? ("knowledge" as const) : data.type,
  })),
);

// 可选字符串：undefined | null | "" 或 trim 后的非空串。等价原 zod 的
// `.nullable().optional().or(z.literal(""))`（zod 里 `.or(literal(""))` 是冗余的，
// 因为 trim 后的 string 已接受 ""）。valibot 用 nullish + trim。
const optionalTrimmedString = () => nullish(pipe(string(), trim()));

// --- 核心 schema ---
export const getCreateAgentSchema = (t: TFunction) => {
  const base = object({
    name: nullish(
      pipe(string(), trim(), maxLength(50, t("validation.nameTooLong"))),
    ),

    /**
     * Stable machine-callable name for agent routing. Unlike name, this is
     * not a display label and should stay unique within the user's agent set.
     */
    handle: optionalTrimmedString(),

    /**
     * provider 不再必填：只是一个可选的标识字段
     */
    provider: optionalTrimmedString(),

    /**
     * 模型：所有模式下必须选择（通过 refine 条件校验）
     */
    model: optionalTrimmedString(),

    /**
     * 模型是否支持图像（来自模型元数据，方便持久化 / 服务端快速判断）
     */
    hasVision: optional(boolean(), false),

    /**
     * API 来源：平台 / 自定义 / CLI
     */
    apiSource: optional(picklist(["platform", "custom", "cli"] as const), "platform"),

    /**
     * 默认交互模式：文本聊天 / 实时语音通话
     */
    defaultInteractionMode: optional(
      picklist(["text", "live_audio"] as const),
      "text",
    ),

    /**
     * 语音配置：例如预设音色
     */
    voiceConfig: nullish(
      object({
        voiceId: optional(string()),
      }),
    ),

    /**
     * CLI provider（apiSource=cli 时有效）：见 CLI_PROVIDER_VALUES
     */
    cliProvider: nullish(picklist(CLI_PROVIDER_VALUES)),

    /**
     * Optional machine binding for CLI agents. Empty means use the server/local
     * CLI runtime; a value means dispatch the CLI run to a connected machine.
     */
    machineId: optionalTrimmedString(),

    customProviderUrl: pipe(
      optionalTrimmedString(),
      check(
        (val) => !val || /^https?:\/\/.+/.test(val),
        t("validation.invalidUrl"),
      ),
    ),

    /**
     * API Key：完全可选（本地 / 无鉴权的自定义接口不需要）
     */
    apiKey: optionalTrimmedString(),

    /**
     * apiKeyRef：指向 OAuth 凭据库的 provider 名称（例如 "chatgpt"）。
     * 设置后由 provider 解析层加载对应 OAuth token 作为 Bearer 鉴权，
     * 与静态 apiKey 互斥优先使用 apiKeyRef。
     */
    apiKeyRef: optionalTrimmedString(),

    /**
     * credentialSynced：是否把 custom api-key 同步到用户服务端账户（可选 opt-in）。
     * 开启后各端 local broker miss 时 fallback 到服务端读取 + 本机缓存。
     * 仅对 custom apiSource + 非 OAuth 凭证的 agent 有意义。
     */
    credentialSynced: optional(boolean()),

    /**
     * apiKeyHeader：自定义鉴权 header 名（例如 "x-api-key"）。
     * 不传时按 endpoint 自动推断，通常为 "Authorization"。
     */
    apiKeyHeader: optionalTrimmedString(),

    useServerProxy: optional(boolean(), true),
    prompt: optionalTrimmedString(),

    /**
     * 工具列表（tools 字段）
     */
    tools: optional(array(string()), []),

    disabledTools: optional(array(string()), []),

    enabledPacks: optional(array(string()), []),

    /**
     * 三态能力配置：slug → "required"（完整启用）/ "recommended"（启用）。
     * 缺席即禁用。与 enabledPacks 双写——后者是给尚未迁移的读取方与旧客户端的
     * 有损降级（recommended 在旧模型没有对应物），见 ai/tools/agentSkillConfig。
     */
    skills: optional(record(string(), picklist(["required", "recommended"] as const))),

    runtimeToolPolicy: nullish(runtimeToolPolicySchema),

    isPublic: optional(boolean(), false),
    allowFork: optional(boolean(), false),

    greeting: nullish(union([string(), greetingConfigSchema])),

    introduction: optionalTrimmedString(),

    inputPrice: pipe(
      optional(number(), 0),
      minValue(0, t("validation.priceMin")),
    ),

    outputPrice: pipe(
      optional(number(), 0),
      minValue(0, t("validation.priceMin")),
    ),

    sharingLevel: nullish(picklist(["default", "split", "full"] as const)),

    avatarFileId: optionalTrimmedString(),

    tags: optionalTrimmedString(),

    references: pipe(
      optional(array(referenceItemSchema), []),
      check(
        (refs) => {
          const dbKeys = (refs ?? []).map((ref) => ref.dbKey);
          return dbKeys.length === new Set(dbKeys).size;
        },
        t("validation.duplicateReferences"),
      ),
    ),

    temperature: nullish(
      pipe(
        number(),
        minValue(0, t("validation.temperatureRange")),
        maxValue(2, t("validation.temperatureRange")),
      ),
    ),

    top_p: nullish(
      pipe(
        number(),
        minValue(0, t("validation.topPRange")),
        maxValue(1, t("validation.topPRange")),
      ),
    ),

    frequency_penalty: nullish(
      pipe(
        number(),
        minValue(-2, t("validation.frequencyPenaltyRange")),
        maxValue(2, t("validation.frequencyPenaltyRange")),
      ),
    ),

    presence_penalty: nullish(
      pipe(
        number(),
        minValue(-2, t("validation.presencePenaltyRange")),
        maxValue(2, t("validation.presencePenaltyRange")),
      ),
    ),

    max_tokens: nullish(
      pipe(
        number(),
        minValue(1, t("validation.maxTokensMin")),
        maxValue(MAX_TOKENS_LIMIT, t("validation.maxTokensMax")),
      ),
    ),

    reasoning_effort: pipe(
      nullish(picklist(REASONING_EFFORT_OPTIONS)),
      transform((v) => v ?? DEFAULT_REASONING_EFFORT),
    ),

    /**
     * enableThinking：是否开启模型思考模式
     * - Ollama/Qwen3: delta.reasoning 字段会流式返回思考过程
     * - Anthropic Claude: 注入 thinking: { type:"enabled", budget_tokens }
     * - DeepSeek: delta.reasoning_content
     */
    enableThinking: optional(boolean(), false),

    /**
     * thinkingBudget：思考 token 预算（仅对支持 budget_tokens 的 provider 生效，如 Anthropic）
     * Ollama/DeepSeek 等不支持 budget_tokens 的 provider 忽略此字段
     */
    thinkingBudget: nullish(
      pipe(
        number(),
        minValue(1024, t("validation.thinkingBudgetMin")),
        maxValue(32000, t("validation.thinkingBudgetMax")),
      ),
    ),

    /**
     * whitelist：白名单
     */
    whitelist: optional(array(pipe(string(), trim(), minLength(1))), []),

    /**
     * linkedSpaces：关联的其他 Space ID 列表
     * Agent 可以访问这些 Space 的目录结构作为粗略上下文
     */
    linkedSpaces: optional(array(pipe(string(), trim(), minLength(1))), []),
  });

  // --- 跨字段校验 ---
  // 1) 自定义 URL 必填：
  //    - 只要 apiSource === "custom"，必须填写 customProviderUrl
  //    - 例外：apiKeyRef 是已知 OAuth provider（如 claude、chatgpt、xai、
  //      cursor、antigravity）时跳过——这些 agent 的 endpoint
  //      由 agentCallPlan 或 OAuth flow 内部解析，不需要用户手填 URL。
  // 2) model 必填规则：platform / custom 模式必填；cli 模式有默认值，不强制
  // 3) machineId 绑定校验：仅 cli 或 custom+本地 URL 可用 machine 绑定
  return pipe(
    base,
    forward(
      check((data) => {
        if (data.apiSource === "custom") {
          const oauthRefs = new Set([
            "chatgpt", "xai", "antigravity", "claude", "cursor",
          ]);
          if (typeof data.apiKeyRef === "string" && oauthRefs.has(data.apiKeyRef)) {
            return true;
          }
          return !!data.customProviderUrl;
        }
        return true;
      }, t("validation.customUrlRequired")),
      ["customProviderUrl"],
    ),
    forward(
      check((data) => {
        if (data.apiSource === "cli") return true;
        return !!data.model?.trim();
      }, t("validation.modelRequired")),
      ["model"],
    ),
    forward(
      check((data) => {
        if (!data.machineId?.trim()) return true;
        const canUseMachineBinding =
          data.apiSource === "cli" ||
          (data.apiSource === "custom" &&
            isLocalCustomProviderUrl(data.customProviderUrl));
        return canUseMachineBinding;
      }, t("validation.machineBindingRequiresCliOrLocalCustom")),
      ["machineId"],
    ),
  );
};

export type FormData = InferOutput<ReturnType<typeof getCreateAgentSchema>>;

export const normalizeReferences = (references: any[]): ReferenceItem[] => {
  if (!Array.isArray(references)) return [];
  return references.map((ref) => ({
    dbKey: ref.dbKey || "",
    title: ref.title || "",
    type: ref.type === "page" ? "knowledge" : ref.type || "knowledge",
  }));
};
