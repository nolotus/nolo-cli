// 文件路径: ai/tools/agent/agentTools.ts

import {
    callAgentFunctionSchema,
    callAgentFunc,
} from "./callAgentTool";
import {
    createAgentToolFunctionSchema,
    createAgentToolFunc,
} from "./createAgentTool";
import {
    prepareAgentDraftToolFunctionSchema,
    prepareAgentDraftToolFunc,
} from "./prepareAgentDraftTool";
import {
    createSkillAgentToolFunctionSchema,
    createSkillAgentToolFunc,
} from "./createSkillAgentTool";
import {
    updateAgentToolFunctionSchema,
    updateAgentToolFunc,
} from "./updateAgentTool";
import {
    updateSelfToolFunctionSchema,
    updateSelfToolFunc,
} from "./updateSelfTool";
import {
    runStreamingAgentFunctionSchema,
    runStreamingAgentFunc,
} from "./runStreamingAgentTool";
import {
    createDialogFunctionSchema,
    createDialogFunc,
} from "./createDialogTool";
import {
    runLlmFunctionSchema,
    runLlmToolFunc,
} from "./runLlmTool";

import type { ToolDefinition } from "../index";

export const agentToolDefinitions: ToolDefinition[] = [
    {
        id: "prepareAgentDraft",
        schema: prepareAgentDraftToolFunctionSchema,
        executor: prepareAgentDraftToolFunc,
        description: {
            name: "prepareAgentDraft",
            description:
                "整理 Agent 创建草稿并交给用户预览确认，不创建真实 Agent。",
            category: "计划与编排",
        },
        behavior: "data",
        uiGroup: "agent",
        capability: "general",
        riskLevel: "low",
        costLevel: "low",
        defaultConsent: "auto",
    },
    {
        id: "createAgent",
        schema: createAgentToolFunctionSchema,
        executor: createAgentToolFunc,
        description: {
            name: "createAgent",
            description:
                "根据给定配置创建一个新的 Agent（智能体 / 应用），并返回其详细信息。",
            category: "计划与编排",
        },
        behavior: "action",
        uiGroup: "agent",
        capability: "self_evolution",
        riskLevel: "high",
        costLevel: "low",
        defaultConsent: "ask",
    },
    {
        id: "createSkillAgent",
        schema: createSkillAgentToolFunctionSchema,
        executor: createSkillAgentToolFunc,
        description: {
            name: "createSkillAgent",
            description:
                "创建专门用于创建/评估 skill 文档协议的 Agent。",
            category: "计划与编排",
        },
        behavior: "action",
        uiGroup: "agent",
        capability: "self_evolution",
        riskLevel: "high",
        costLevel: "low",
        defaultConsent: "ask",
    },
    {
        id: "updateSelf",
        schema: updateSelfToolFunctionSchema,
        executor: updateSelfToolFunc,
        description: {
            name: "updateSelf",
            description:
                "更新当前正在运行的 Agent 自己。低风险字段可直接更新，高影响字段会先请求确认。",
            category: "计划与编排",
        },
        behavior: "action",
        uiGroup: "agent",
        capability: "self_evolution",
        riskLevel: "high",
        costLevel: "low",
        defaultConsent: "ask",
    },
    {
        id: "updateAgent",
        schema: updateAgentToolFunctionSchema,
        executor: updateAgentToolFunc,
        description: {
            name: "updateAgent",
            description:
                "根据给定配置更新已经存在的 Agent。只会修改参数中出现的字段，未提供的字段保持不变。",
            category: "计划与编排",
        },
        behavior: "action",
        uiGroup: "agent",
        capability: "self_evolution",
        riskLevel: "high",
        costLevel: "low",
        defaultConsent: "ask",
    },
    {
        id: "callAgent",
        schema: callAgentFunctionSchema,
        executor: callAgentFunc,
        description: {
            name: "callAgent",
            description:
                "调用一个指定的 Agent 执行一次子任务，可用于多 Agent 编排、自动评测、自动对比等场景。",
            category: "计划与编排",
        },
        behavior: "orchestrator",
        uiGroup: "agent",
    },
    {
        id: "runStreamingAgent",
        schema: runStreamingAgentFunctionSchema,
        executor: runStreamingAgentFunc,
        description: {
            name: "runStreamingAgent",
            description:
                "将本轮回答交由指定的 Agent 以流式方式输出，常用于从通用助手切换到某个专用应用。",
            category: "计划与编排",
        },
        behavior: "orchestrator",
        uiGroup: "agent",
    },
    {
        id: "createDialog",
        schema: createDialogFunctionSchema,
        executor: createDialogFunc,
        description: {
            name: "createDialog",
            description:
                "创建一个新的对话，指定 Agent 响应，可选发送第一条消息触发执行。返回 dialogId 可随时查看结果。",
            category: "计划与编排",
        },
        behavior: "action",
        uiGroup: "agent",
    },
    {
        id: "runLlm",
        schema: runLlmFunctionSchema,
        executor: runLlmToolFunc,
        description: {
            name: "runLlm",
            description:
                "对指定模型发起一次单轮 LLM 调用，不加载知识库也不调用工具。适合摘要、分类、格式化等纯文本处理任务。",
            category: "计划与编排",
        },
        behavior: "action",
        uiGroup: "agent",
    },
];
