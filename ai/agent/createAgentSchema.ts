// 路径: ai/agent/createAgentSchema.ts

import { ReferenceItem } from "../../app/types"; // 确保 app/types 里有 ReferenceItem 定义
import { TFunction } from "i18next";
import { z } from "zod";

// --- 常量 ---
export const DEFAULT_TEMPERATURE = 0.7;
export const DEFAULT_TOP_P = 1;
export const DEFAULT_FREQUENCY_PENALTY = 0.0;
export const DEFAULT_PRESENCE_PENALTY = 0.0;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_REASONING_EFFORT = "medium";

export const REASONING_EFFORT_OPTIONS = ["low", "medium", "high"] as const;
const greetingMenuItemSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  userMessage: z.string().optional(),
});

const greetingConfigSchema = z.object({
  text: z.string().trim().optional(),
  menu: z.array(greetingMenuItemSchema).optional(),
});

const runtimeToolPolicySchema = z
  .object({
    version: z.literal(1).optional(),
    agentTools: z.array(z.string()).optional(),
    runtimeTools: z.array(z.string()).optional(),
    workspace: z
      .object({
        mode: z.enum(["none", "current", "lease"]).optional(),
        writableRoots: z.array(z.string()).optional(),
        cwd: z.string().optional(),
      })
      .optional(),
    shell: z.record(z.unknown()).optional(),
    isolation: z.record(z.unknown()).optional(),
    git: z.record(z.unknown()).optional(),
    budget: z.record(z.unknown()).optional(),
    audit: z.record(z.unknown()).optional(),
  })
  .passthrough();

const isLocalCustomProviderUrl = (value: unknown): boolean => {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
};

const referenceItemSchema = z
  .object({
    dbKey: z.string(),
    title: z.string(),
    type: z.enum(["knowledge", "instruction", "page"]),
  })
  .transform((data) => ({
    ...data,
    type: data.type === "page" ? "knowledge" : data.type,
  }));

// --- 核心 schema ---
export const getCreateAgentSchema = (t: TFunction) =>
  z
    .object({
      name: z
        .string()
        .trim()
        .min(1, t("validation.nameRequired"))
        .max(50, t("validation.nameTooLong")),

      /**
       * Stable machine-callable name for agent routing. Unlike name, this is
       * not a display label and should stay unique within the user's agent set.
       */
      handle: z.string().trim().nullable().optional().or(z.string().length(0)),

      /**
       * provider 不再必填：只是一个可选的标识字段
       */
      provider: z.string().trim().nullable().optional().or(z.string().length(0)),

      /**
       * 模型：所有模式下必须选择（通过 refine 条件校验）
       */
      model: z.string().trim().nullable().optional().or(z.string().length(0)),

      /**
       * 模型是否支持图像（来自模型元数据，方便持久化 / 服务端快速判断）
       */
      hasVision: z.boolean().optional().default(false),

      /**
       * API 来源：平台 / 自定义 / CLI
       */
      apiSource: z.enum(["platform", "custom", "cli"]).default("platform"),

      /**
       * 默认交互模式：文本聊天 / 实时语音通话
       */
      defaultInteractionMode: z.enum(["text", "live_audio"]).default("text"),

      /**
       * 语音配置：例如预设音色
       */
      voiceConfig: z
        .object({
          voiceId: z.string().optional(),
        })
        .nullable()
        .optional(),

      /**
       * CLI provider（apiSource=cli 时有效）：支持 "copilot" | "gemini" | "codex" | "claude" | "agy" | "qoder" | "opencode" | "grok" | "kimi"
       */
      cliProvider: z
        .enum(["copilot", "gemini", "codex", "claude", "agy", "qoder", "opencode", "grok", "kimi"])
        .nullable()
        .optional()
        .or(z.literal("")),

      /**
       * Optional machine binding for CLI agents. Empty means use the server/local
       * CLI runtime; a value means dispatch the CLI run to a connected machine.
       */
      machineId: z.string().trim().nullable().optional().or(z.string().length(0)),

      customProviderUrl: z
        .string()
        .trim()
        .nullable()
        .optional()
        .or(z.string().length(0))
        .refine((val) => !val || z.string().url().safeParse(val).success, {
          message: t("validation.invalidUrl"),
        }),

      /**
       * API Key：完全可选（本地 / 无鉴权的自定义接口不需要）
       */
      apiKey: z.string().trim().nullable().optional().or(z.string().length(0)),

      /**
       * apiKeyRef：指向 OAuth 凭据库的 provider 名称（例如 "chatgpt"）。
       * 设置后由 provider 解析层加载对应 OAuth token 作为 Bearer 鉴权，
       * 与静态 apiKey 互斥优先使用 apiKeyRef。
       */
      apiKeyRef: z.string().trim().nullable().optional().or(z.string().length(0)),

      /**
       * apiKeyHeader：自定义鉴权 header 名（例如 "x-api-key"）。
       * 不传时按 endpoint 自动推断，通常为 "Authorization"。
       */
      apiKeyHeader: z.string().trim().nullable().optional().or(z.string().length(0)),

      useServerProxy: z.boolean().default(true),
      prompt: z.string().trim().nullable().optional().or(z.string().length(0)),

      tools: z.array(z.string()).default([]),

      runtimeToolPolicy: runtimeToolPolicySchema.nullable().optional(),

      isPublic: z.boolean().default(false),

      greeting: z
        .union([z.string(), greetingConfigSchema])
        .nullable()
        .optional(),

      introduction: z.string().trim().nullable().optional().or(z.string().length(0)),

      inputPrice: z.number().min(0, t("validation.priceMin")).default(0),

      outputPrice: z.number().min(0, t("validation.priceMin")).default(0),

      sharingLevel: z.enum(["default", "split", "full"]).nullable().optional(),

      avatarFileId: z.string().nullable().optional().or(z.string().length(0)),

      tags: z.string().trim().nullable().optional().or(z.string().length(0)),

      references: z
        .array(referenceItemSchema)
        .optional()
        .default([])
        .refine(
          (refs) => {
            const dbKeys = refs?.map((ref) => ref.dbKey) || [];
            return dbKeys.length === new Set(dbKeys).size;
          },
          { message: t("validation.duplicateReferences") }
        ),

      temperature: z
        .number()
        .min(0, t("validation.temperatureRange"))
        .max(2, t("validation.temperatureRange"))
        .nullable()
        .optional(),

      top_p: z
        .number()
        .min(0, t("validation.topPRange"))
        .max(1, t("validation.topPRange"))
        .nullable()
        .optional(),

      frequency_penalty: z
        .number()
        .min(-2, t("validation.frequencyPenaltyRange"))
        .max(2, t("validation.frequencyPenaltyRange"))
        .nullable()
        .optional(),

      presence_penalty: z
        .number()
        .min(-2, t("validation.presencePenaltyRange"))
        .max(2, t("validation.presencePenaltyRange"))
        .nullable()
        .optional(),

      max_tokens: z
        .number()
        .min(1, t("validation.maxTokensMin"))
        .max(500000, t("validation.maxTokensMax"))
        .nullable()
        .optional(),

      reasoning_effort: z
        .enum(REASONING_EFFORT_OPTIONS, {
          errorMap: () => ({ message: t("validation.reasoningEffortInvalid") }),
        })
        .nullable()
        .optional()
        .transform((v) => v ?? DEFAULT_REASONING_EFFORT),

      /**
       * enableThinking：是否开启模型思考模式
       * - Ollama/Qwen3: delta.reasoning 字段会流式返回思考过程
       * - Anthropic Claude: 注入 thinking: { type:"enabled", budget_tokens }
       * - DeepSeek: delta.reasoning_content
       */
      enableThinking: z.boolean().optional().default(false),

      /**
       * thinkingBudget：思考 token 预算（仅对支持 budget_tokens 的 provider 生效，如 Anthropic）
       * Ollama/DeepSeek 等不支持 budget_tokens 的 provider 忽略此字段
       */
      thinkingBudget: z
        .number()
        .min(1024, t("validation.thinkingBudgetMin"))
        .max(32000, t("validation.thinkingBudgetMax"))
        .nullable()
        .optional(),

      /**
       * whitelist：白名单
       */
      whitelist: z.array(z.string().trim().min(1)).optional().default([]),

      /**
       * linkedSpaces：关联的其他 Space ID 列表
       * Agent 可以访问这些 Space 的目录结构作为粗略上下文
       */
      linkedSpaces: z.array(z.string().trim().min(1)).optional().default([]),
    })
    // --- refine 逻辑 ---
    // 1) 自定义 URL 必填：
    //    - 只要 apiSource === "custom"，必须填写 customProviderUrl
    .refine(
      (data) => {
        if (data.apiSource === "custom") {
          return !!data.customProviderUrl;
        }
        return true;
      },
      {
        message: t("validation.customUrlRequired"),
        path: ["customProviderUrl"],
      }
    )
    // 2) model 必填规则：
    //    - platform / custom 模式必填；cli 模式有默认值，不强制
    .refine(
      (data) => {
        if (data.apiSource === "cli") return true;
        return !!data.model?.trim();
      },
      {
        message: t("validation.modelRequired"),
        path: ["model"],
      }
    )
    .superRefine((data, ctx) => {
      if (!data.machineId?.trim()) return;
      const canUseMachineBinding =
        data.apiSource === "cli" ||
        (data.apiSource === "custom" &&
          isLocalCustomProviderUrl(data.customProviderUrl));
      if (canUseMachineBinding) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["machineId"],
        message: t("validation.machineBindingRequiresCliOrLocalCustom"),
      });
    });

export type FormData = z.infer<ReturnType<typeof getCreateAgentSchema>>;

export const normalizeReferences = (references: any[]): ReferenceItem[] => {
  if (!Array.isArray(references)) return [];
  return references.map((ref) => ({
    dbKey: ref.dbKey || "",
    title: ref.title || "",
    type: ref.type === "page" ? "knowledge" : ref.type || "knowledge",
  }));
};
