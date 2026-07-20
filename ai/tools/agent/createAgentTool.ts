// 文件路径: ai/tools/agent/createAgentTool.ts

import type { RootState } from "../../../app/store";
import type { Agent } from "../../../app/types";
import { createAgent } from "../../agent/agentSlice";
import { selectAllMemberSpaces, addContentToSpace } from "../../../create/space/spaceSlice";
import { ContentType } from "../../../app/types";
import { createAgentKey, } from "../../../database/keys";
import type { FormData as AgentFormData } from "../../agent/createAgentSchema";
import { selectCurrentUserBalance } from "../../../auth/authSlice";
import { selectIdentityUserId } from "identity/selectors";
import type { ModelWithProvider } from "../../llm/models";
import i18n from "../../../app/i18n";
import { toTrimmedString } from "../../../core/toTrimmedString";

type ReasoningEffort = "low" | "medium" | "high";

type ReferenceArg = {
    dbKey: string;
    title?: string;
    type?: "knowledge" | "instruction" | "page";
};

// 与 GreetingMenuEditor / greetingMenuItemSchema 对齐
export type GreetingMenuItemArg = {
    id: string;
    label: string;
    userMessage?: string;
};

export type GreetingConfigArg = {
    text?: string;
    menu?: GreetingMenuItemArg[];
};

export type CreateAgentToolArgs = {
    name: string;
    model: string;
    provider: string; // 必填
    prompt?: string;
    introduction?: string;
    greeting?: string | GreetingConfigArg; // 支持纯文本或带 menu 的对象
    isPublic?: boolean;
    tags?: string[] | string;
    tools?: string[];
    references?: ReferenceArg[];
    linkedSpaces?: string[];
    temperature?: number;
    top_p?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    max_tokens?: number;
    reasoning_effort?: ReasoningEffort;
    runtimeToolPolicy?: Record<string, unknown> | null;
};

const HOSTED_EXEC_RUNTIME_TOOL_POLICY = {
    version: 1 as const,
    runtimeTools: ["execShell"] as string[],
    workspace: { mode: "lease" as const },
};

/**
 * 根据 model + 可选 provider 找到唯一的模型配置
 *
 * 规则：
 * - 如果传了 provider，则优先按 (name, provider) 精确匹配；
 * - 否则按 name 匹配：
 *    - 找到 1 个 => 返回
 *    - 找到 0 或 >1 个 => 返回 null（>1 说明有歧义）
 */
const findModelConfig = async (
    modelName: string,
    provider?: string
): Promise<ModelWithProvider | null> => {
    const { ALL_MODELS } = await import("../../llm/models");
    const name = toTrimmedString(modelName);
    const prov = toTrimmedString(provider ?? "");
    if (!name) return null;

    if (prov) {
        const exact = ALL_MODELS.find(
            (m) => m.name === name && m.provider === prov
        );
        if (exact) return exact;
    }

    const matches = ALL_MODELS.filter((m) => m.name === name);
    if (matches.length === 1) return matches[0];

    if (matches.length > 1 && !prov) {
        console.warn(
            "[createAgentTool] findModelConfig: duplicate model names without provider",
            {
                modelName: name,
                providers: matches.map((m) => m.provider),
            }
        );
    }

    return null;
};

/**
 * [Schema] createAgent 工具定义：供 LLM 规划时调用
 * - name / model / provider 必填：保证创建出来的 Agent 配置完整且无歧义
 * - 其余字段可选：用于进一步定制 Agent 行为
 */
export const createAgentToolFunctionSchema = {
    name: "createAgent",
    description: i18n.t("tools.createAgent.description"),
    parameters: {
        type: "object",
        properties: {
            name: {
                type: "string",
                description: i18n.t("tools.createAgent.params.name"),
            },
            model: {
                type: "string",
                description: i18n.t("tools.createAgent.params.model"),
            },
            provider: {
                type: "string",
                description: i18n.t("tools.createAgent.params.provider"),
            },
            prompt: {
                type: "string",
                description: i18n.t("tools.createAgent.params.prompt"),
            },
            introduction: {
                type: "string",
                description: i18n.t("tools.createAgent.params.introduction"),
            },
            greeting: {
                description: i18n.t("tools.createAgent.params.greeting.desc"),
                anyOf: [
                    {
                        type: "string",
                        description: i18n.t(
                            "tools.createAgent.params.greeting.stringDesc"
                        ),
                    },
                    {
                        type: "object",
                        description: i18n.t(
                            "tools.createAgent.params.greeting.objectDesc"
                        ),
                        properties: {
                            text: {
                                type: "string",
                                description: i18n.t(
                                    "tools.createAgent.params.greeting.texts.text"
                                ),
                            },
                            menu: {
                                type: "array",
                                description: i18n.t(
                                    "tools.createAgent.params.greeting.menu.desc"
                                ),
                                items: {
                                    type: "object",
                                    properties: {
                                        id: {
                                            type: "string",
                                            description: i18n.t(
                                                "tools.createAgent.params.greeting.menu.id"
                                            ),
                                        },
                                        label: {
                                            type: "string",
                                            description: i18n.t(
                                                "tools.createAgent.params.greeting.menu.label"
                                            ),
                                        },
                                        userMessage: {
                                            type: "string",
                                            description: i18n.t(
                                                "tools.createAgent.params.greeting.menu.userMessage"
                                            ),
                                        },
                                    },
                                    required: ["id", "label"],
                                },
                            },
                        },
                    },
                ],
            },
            isPublic: {
                type: "boolean",
                description: i18n.t("tools.createAgent.params.isPublic"),
            },
            tags: {
                type: "array",
                items: { type: "string" },
                description: i18n.t("tools.createAgent.params.tags"),
            },
            tools: {
                type: "array",
                items: { type: "string" },
                description: i18n.t("tools.createAgent.params.tools"),
            },
            runtimeToolPolicy: {
                type: "object",
                description:
                    "Internal runtime policy for executable agent capabilities. Use only when an agent needs shell/script execution; do not expose this as a user-facing setup step.",
            },
            references: {
                type: "array",
                description: i18n.t("tools.createAgent.params.references.desc"),
                items: {
                    type: "object",
                    properties: {
                        dbKey: {
                            type: "string",
                            description: i18n.t(
                                "tools.createAgent.params.references.dbKey"
                            ),
                        },
                        title: {
                            type: "string",
                            description: i18n.t(
                                "tools.createAgent.params.references.title"
                            ),
                        },
                        type: {
                            type: "string",
                            enum: ["knowledge", "instruction", "page"],
                            description: i18n.t(
                                "tools.createAgent.params.references.type"
                            ),
                        },
                    },
                    required: ["dbKey"],
                },
            },
            linkedSpaces: {
                type: "array",
                items: { type: "string" },
                description: i18n.t("tools.createAgent.params.linkedSpaces"),
            },
            temperature: {
                type: "number",
                description: i18n.t("tools.createAgent.params.temperature"),
            },
            top_p: {
                type: "number",
                description: i18n.t("tools.createAgent.params.top_p"),
            },
            frequency_penalty: {
                type: "number",
                description: i18n.t(
                    "tools.createAgent.params.frequency_penalty"
                ),
            },
            presence_penalty: {
                type: "number",
                description: i18n.t(
                    "tools.createAgent.params.presence_penalty"
                ),
            },
            max_tokens: {
                type: "number",
                description: i18n.t("tools.createAgent.params.max_tokens"),
            },
            reasoning_effort: {
                type: "string",
                enum: ["low", "medium", "high"],
                description: i18n.t(
                    "tools.createAgent.params.reasoning_effort"
                ),
            },
        },
        // provider 必填
        required: ["name", "model", "provider"],
    },
};

const normalizeTags = (tags?: string[] | string): string => {
    if (!tags) return "";
    if (Array.isArray(tags)) {
        return tags
            .map((t) => toTrimmedString(t))
            .filter(Boolean)
            .join(", ");
    }
    return String(tags);
};

/**
 * 将工具入参转换为 Agent 表单数据结构（AgentFormData）
 * - 默认使用平台 API（apiSource: 'platform'）
 * - 不暴露自定义 API 字段（customProviderUrl / apiKey 等）
 * - 根据 (model, provider) 自动补 hasVision 等能力字段
 */
const buildFormDataFromArgs = async (args: CreateAgentToolArgs): Promise<AgentFormData> => {
    const {
        name,
        model,
        provider,
        prompt,
        introduction,
        greeting,
        isPublic = false,
        tags,
        tools,
        references,
        linkedSpaces,
        temperature,
        top_p,
        frequency_penalty,
        presence_penalty,
        max_tokens,
        reasoning_effort,
        runtimeToolPolicy,
    } = args;

    const trimmedName = toTrimmedString(name);
    const trimmedModel = toTrimmedString(model);
    const trimmedProvider = toTrimmedString(provider);

    // 用 (model, provider) 查模型元数据，顺便拿 hasVision 等能力
    const modelConfig = await findModelConfig(trimmedModel, trimmedProvider);
    const { getModelPricing } = await import("../../llm/getPricing");

    const normalizedTools = tools ?? [];
    const resolvedRuntimeToolPolicy =
        runtimeToolPolicy ??
        (normalizedTools.includes("execShell")
            ? HOSTED_EXEC_RUNTIME_TOOL_POLICY
            : undefined);

    const formData: AgentFormData = {
        name: trimmedName,
        model: trimmedModel,
        provider: modelConfig?.provider || trimmedProvider,

        apiSource: "platform",
        useServerProxy: true,
        enableThinking: false,
        defaultInteractionMode: "text",

        // 根据模型配置自动赋值 hasVision（支持图片 / 多模态）
        hasVision: Boolean(modelConfig?.hasVision),

        prompt: prompt ?? "",
        introduction: introduction ?? "",
        greeting, // 直接透传：string 或 { text, menu }
        isPublic: !!isPublic,
        tags: normalizeTags(tags),

        tools: normalizedTools,
        ...(resolvedRuntimeToolPolicy ? { runtimeToolPolicy: resolvedRuntimeToolPolicy } : {}),
        references: (references as any) ?? [],
        linkedSpaces: linkedSpaces ?? [], // Leave raw inputs, resolve in executor

        customProviderUrl: "",
        apiKey: "",

        // 从模型列表查真实价格，保证 AgentCard 和 useSendPermission 能正确显示
        ...(() => {
          const pricing = getModelPricing(modelConfig?.provider || trimmedProvider, trimmedModel);
          return {
            inputPrice: pricing?.inputPrice ?? 0,
            outputPrice: pricing?.outputPrice ?? 0,
          };
        })(),

        temperature,
        top_p,
        frequency_penalty,
        presence_penalty,
        max_tokens,
        reasoning_effort: reasoning_effort ?? "medium",

        whitelist: [],
    };

    return formData;
};

/**
 * [Helper] 根据 Space 名称或 ID 查找 Space
 */
const findSpaceConfig = (
    nameOrId: string,
    allSpaces: any[]
): { spaceId: string; name: string } | null => {
    const query = toTrimmedString(nameOrId).toLowerCase();
    if (!query) return null;

    // 1. 精确匹配 ID
    const byId = allSpaces.find((s) => s.spaceId === nameOrId); // ID 区分大小写
    if (byId) return { spaceId: byId.spaceId, name: byId.spaceName };

    // 2. 匹配名称 (忽略大小写)
    const byName = allSpaces.find(
        (s) =>
            (s.spaceName || "").toLowerCase() === query ||
            (s.spaceId || "").toLowerCase() === query
    );
    if (byName) return { spaceId: byName.spaceId, name: byName.spaceName };

    return null;
};

/**
 * [Executor] createAgent 工具执行函数
 */
export async function createAgentToolFunc(
    args: CreateAgentToolArgs,
    thunkApi: any
): Promise<{ rawData: Agent; displayData: string }> {
    const state = thunkApi.getState() as RootState;
    const currentUserId = selectIdentityUserId(state);
    const currentBalance = selectCurrentUserBalance(state);

    // 获取当前用户的所有 Space (from create/space/spaceSlice)
    const allSpaces = selectAllMemberSpaces(state);

    if (!currentUserId) {
        throw new Error("创建 Agent 失败：当前未登录或缺少 userId。");
    }

    const { name, model, provider, linkedSpaces } =
        args || ({} as CreateAgentToolArgs);

    if (!name || typeof name !== "string" || !name.trim()) {
        throw new Error("创建 Agent 失败：必须提供非空的 name 字段。");
    }
    if (!model || typeof model !== "string" || !model.trim()) {
        throw new Error("创建 Agent 失败：必须提供非空的 model 字段。");
    }
    if (!provider || typeof provider !== "string" || !provider.trim()) {
        throw new Error("创建 Agent 失败：必须提供非空的 provider 字段。");
    }

    // --- 处理 Space ID / Name 解析 ---
    const resolvedLinkedSpaces: string[] = [];
    if (Array.isArray(linkedSpaces) && linkedSpaces.length > 0) {
        const notFound: string[] = [];
        for (const input of linkedSpaces) {
            const found = findSpaceConfig(input, allSpaces);
            if (found) {
                resolvedLinkedSpaces.push(found.spaceId);
            } else {
                notFound.push(input);
            }
        }

        if (notFound.length > 0) {
            // 如果有找不到的 Space，生成详细错误提示，列出可用 Space
            const availableList = allSpaces
                .map((s: any) => `- ${s.spaceName} (ID: ${s.spaceId})`)
                .join("\n");
            throw new Error(
                `无法找到以下 Space: ${notFound.join(", ")}。\n` +
                `请检查名称拼写或使用 'listUserSpaces' 获取最新列表。\n` +
                `当前可用 Space:\n${availableList}`
            );
        }
    }

    const formData = await buildFormDataFromArgs(args);
    // 覆盖为解析后的 ID 列表
    formData.linkedSpaces = resolvedLinkedSpaces;

    try {
        const agent: Agent = await thunkApi
            .dispatch(
                createAgent({
                    userId: currentUserId,
                    formData,
                    spaceId: state.space.currentSpaceId || undefined,
                })
            )
            .unwrap();

        // 自动添加到当前空间侧边栏
        const currentSpaceId = state.space.currentSpaceId;
        if (currentSpaceId) {
            // 新创建的 Agent 统一使用 createAgentKey (agent- 前缀)
            const agentDbKey = agent.isPublic
                ? createAgentKey.public(agent.id)
                : createAgentKey.private(currentUserId, agent.id);

            try {
                await thunkApi.dispatch((addContentToSpace as any)({
                    spaceId: currentSpaceId,
                    title: agent.name || "未命名智能体",
                    type: ContentType.AGENT, // 统一使用 ContentType.AGENT
                    contentKey: agentDbKey,
                })).unwrap();
            } catch (err) {
                console.error("[createAgentTool] Failed to add to space:", err);
            }
        }

        const lines: string[] = [
            `✅ 已创建 Agent：${agent.name}`,
            `- ID: ${agent.id}`,
            `- 模型: ${agent.model || "(未指定)"}`,
            `- Provider: ${agent.provider || "(未指定)"}`,
            `- 是否公开: ${agent.isPublic ? "是" : "否"}`,
        ];

        if (Array.isArray(agent.tags) && agent.tags.length > 0) {
            lines.push(`- 标签: ${agent.tags.join(", ")}`);
        }
        if (Array.isArray(agent.tools) && agent.tools.length > 0) {
            lines.push(`- 启用工具: ${agent.tools.join(", ")}`);
        }
        if (typeof agent.temperature === "number") {
            lines.push(`- temperature: ${agent.temperature}`);
        }
        if (typeof currentBalance === "number") {
            lines.push(`- 当前余额: ${currentBalance}`);
        }

        return {
            rawData: agent,
            displayData: lines.join("\n"),
        };
    } catch (error: any) {
        throw new Error(
            `创建 Agent 失败：${error?.message || "未知错误，请稍后重试。"}`
        );
    }
}
