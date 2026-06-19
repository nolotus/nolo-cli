// 路径: ai/agent/agentSlice.ts

import { asyncThunkCreator, buildCreateSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { Agent, AgentRuntimeBinding, ReferenceItem } from "../../app/types";

import { write, patch, remove } from "../../database/dbSlice";
import { createCybotKey, createAgentKey } from "../../database/keys";
import { DataType } from "../../create/types";
import { ulid } from "ulid";
import type { FormData as AgentFormData } from "../agent/createAgentSchema";
import { normalizeAgentRuntimeToolPolicy } from "../../agent-runtime/runtimeToolPolicy";

const createSliceWithThunks = buildCreateSlice({
  creators: { asyncThunk: asyncThunkCreator },
});

/** Slice State 定义 */
interface AgentState {
  pubCybots: {
    loading: boolean;
    error: string | null;
    data: Agent[];
  };
}

/** runLlm 参数（通用 LLM 调用） */
interface RunLlmArgs {
  /** 直接传入内置 llmConfig，完全不依赖 Agent 数据 */
  llmConfig?: Partial<Agent> & Pick<Agent, "provider" | "model">;
  agentKey?: string;
  /** 兼容旧调用：直接传入 agentConfig，跳过 DB 读取 */
  agentConfig?: Partial<Agent> & Pick<Agent, "provider" | "model">;
  content: unknown;
  isStreaming?: boolean;
  parentMessageId?: string;
  /** 覆盖 Agent 配置中的 system prompt */
  systemPromptOverride?: string;
  /** 覆盖 Agent 配置中的工具列表（tool id 数组） */
  toolsOverride?: string[];
  billingDialogKey?: string;
}

/** runAgent 参数（通用 Agent 调用，多轮工具循环） */
interface RunAgentArgs {
  agentKey: string;
  content: unknown;
  parentMessageId?: string;
  billingDialogKey?: string;
}

/** createAgent 参数（新建 Agent） */
interface CreateAgentArgs {
  userId: string;
  formData: AgentFormData; // 已通过表单或 Tool 构造的完整数据
  spaceId?: string; // 可选的空间 ID，如果提供，则将 Agent 添加到该空间
}

/** updateAgent 参数（更新 Agent，支持部分字段 patch） */
interface UpdateAgentArgs {
  userId: string;
  agentId: string; // 纯 id（不带 db path 前缀）
  formData: Partial<AgentFormData>; // 允许只传需要修改的字段
  previousAgent?: Partial<Agent>; // UI 编辑时可以传，用来保持公共副本同步
}

const initialState: AgentState = {
  pubCybots: {
    loading: false,
    error: null,
    data: [],
  },
};

const normalizeAgentReferences = (references: any[]): ReferenceItem[] => {
  if (!Array.isArray(references)) return [];
  return references.map((ref) => ({
    dbKey: ref.dbKey || "",
    title: ref.title || "",
    type: ref.type === "page" ? "knowledge" : ref.type || "knowledge",
  }));
};

const normalizeRuntimeToolPolicy = (value: unknown) => {
  const policy = normalizeAgentRuntimeToolPolicy(value);
  if (!policy) return undefined;
  const hasPolicyContent = Boolean(
    policy.agentTools?.length ||
      policy.runtimeTools?.length ||
      policy.workspace ||
      policy.shell ||
      policy.isolation ||
      policy.git ||
      policy.budget ||
      policy.audit
  );
  return hasPolicyContent ? policy : undefined;
};

/**
 * 创建场景：表单数据 -> 持久化数据（全量）
 */
const processAgentCreateForm = (formData: AgentFormData, userId: string) => {
  const isPublic = !!formData.isPublic;
  const machineId = typeof (formData as any).machineId === "string"
    ? (formData as any).machineId.trim()
    : "";

  const result: any = {
    ...formData,
    // tags: "a, b" -> ["a", "b"]
    tags: formData.tags
      ? formData.tags
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      : [],
    // 归一化 references
    references: normalizeAgentReferences(formData.references || []),
    // 非公开时，强制清空白名单，避免脏数据
    whitelist: isPublic ? formData.whitelist || [] : [],
  };

  delete result.machineId;
  result.runtimeToolPolicy = normalizeRuntimeToolPolicy(
    (formData as any).runtimeToolPolicy
  );
  if (!result.runtimeToolPolicy) {
    delete result.runtimeToolPolicy;
  }

  if (formData.apiSource === "cli" && machineId) {
    const binding: AgentRuntimeBinding = {
      ...(result.runtimeBinding && typeof result.runtimeBinding === "object"
        ? result.runtimeBinding
        : {}),
      machineId,
      ownerUserId: userId,
    };
    result.runtimeBinding = binding;
  }

  return result;
};

/**
 * 更新场景：部分表单字段 -> patch changes
 * - 只对传进来的字段做转换 / 归一化
 * - 未出现在 formData 里的字段一律不修改
 */
const processAgentUpdateChanges = (
  data: Partial<AgentFormData>,
  userId: string,
  previousAgent?: Partial<Agent>
) => {
  const changes: any = {};

  // 基本字符串字段
  if ("name" in data) {
    changes.name = String(data.name ?? "").trim();
  }
  if ("model" in data) {
    changes.model = (data.model ?? "").trim();
  }
  if ("provider" in data) {
    changes.provider = (data.provider ?? "").trim();
  }
  if ("prompt" in data) {
    changes.prompt = (data.prompt ?? "").trim();
  }
  if ("introduction" in data) {
    changes.introduction = (data.introduction ?? "").trim();
  }
  if ("customProviderUrl" in data) {
    changes.customProviderUrl = (data.customProviderUrl ?? "").trim();
  }
  if ("apiKey" in data) {
    changes.apiKey = (data.apiKey ?? "").trim();
  }

  // 简单标志位
  if ("hasVision" in data && data.hasVision !== undefined) {
    changes.hasVision = !!data.hasVision;
  }
  if ("apiSource" in data && data.apiSource) {
    changes.apiSource = data.apiSource;
  }
  if ("cliProvider" in data) {
    changes.cliProvider = (data as any).cliProvider || "";
  }
  if ("machineId" in data) {
    const machineId = String((data as any).machineId ?? "").trim();
    
    // Determine effective apiSource: prefer data.apiSource, fall back to previousAgent.apiSource
    const effectiveApiSource = data.apiSource ?? previousAgent?.apiSource;
    
    if (machineId) {
      // Persist runtimeBinding when effective apiSource is 'cli' or undefined
      // undefined = tool/legacy partial update without apiSource context → preserve backward compatibility
      if (effectiveApiSource === "cli" || effectiveApiSource === undefined) {
        const binding: AgentRuntimeBinding = {
          ...((changes.runtimeBinding && typeof changes.runtimeBinding === "object")
            ? changes.runtimeBinding
            : {}),
          machineId,
          ownerUserId: userId,
        };
        changes.runtimeBinding = binding;
      }
      // If apiSource is explicitly non-cli and machineId is supplied, do not create binding
    } else {
      // CLEAR branch: clear runtimeBinding when effectiveApiSource is 'cli' or undefined (backward-compatible)
      if (effectiveApiSource === "cli" || effectiveApiSource === undefined) {
        changes.runtimeBinding = null;
      }
    }
  }
  if ("useServerProxy" in data && data.useServerProxy !== undefined) {
    changes.useServerProxy = !!data.useServerProxy;
  }
  if ("sharingLevel" in data) {
    const sharingLevel = (data as any).sharingLevel;
    if (
      sharingLevel === "default" ||
      sharingLevel === "split" ||
      sharingLevel === "full"
    ) {
      changes.sharingLevel = sharingLevel;
    }
  }

  // greeting / tools 直接透传
  if ("greeting" in data) {
    changes.greeting = data.greeting as any;
  }
  if ("tools" in data) {
    changes.tools = Array.isArray(data.tools) ? data.tools.slice() : [];
  }
  if ("runtimeToolPolicy" in data) {
    const rawRuntimeToolPolicy = (data as any).runtimeToolPolicy;
    changes.runtimeToolPolicy =
      rawRuntimeToolPolicy === null
        ? null
        : normalizeRuntimeToolPolicy(rawRuntimeToolPolicy) ?? null;
  }

  // 数值字段
  const numericKeys: (keyof AgentFormData)[] = [
    "inputPrice",
    "outputPrice",
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "max_tokens",
  ];
  numericKeys.forEach((key) => {
    if (key in data) {
      const raw = data[key];
      if (raw === undefined || raw === null) {
        changes[key] = raw as any;
      } else {
        const num = Number(raw as any);
        changes[key] = Number.isNaN(num) ? raw : num;
      }
    }
  });

  // ⚠ 唯一实质改动：reasoning_effort 允许传 null，用于“清空该字段”
  // 原来是：if ("reasoning_effort" in data && data.reasoning_effort) { ... }
  // 这样会把 null 吞掉，无法让后端 patch + deepMerge 删除字段。
  if ("reasoning_effort" in data) {
    changes.reasoning_effort = (data as any).reasoning_effort;
  }

  // tags: string 或 string[]
  if ("tags" in data) {
    const raw = (data as any).tags;
    let arr: string[] = [];
    if (Array.isArray(raw)) {
      arr = raw.map((s) => String(s || "").trim()).filter(Boolean);
    } else if (typeof raw === "string") {
      arr = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    changes.tags = arr;
  }

  // references
  if ("references" in data) {
    changes.references = normalizeAgentReferences(
      ((data.references as any) || []) as any[]
    );
  }

  // whitelist + isPublic
  if ("whitelist" in data) {
    changes.whitelist = (data.whitelist as string[]) || [];
  }

  if ("isPublic" in data) {
    changes.isPublic = !!data.isPublic;
    if (!changes.isPublic) {
      // 一旦改为私有，强制清空白名单
      changes.whitelist = [];
    }
  }

  return changes;
};

export const slice = createSliceWithThunks({
  // 注意：保持 name = "cybot"，以兼容原有 Redux state 结构
  name: "cybot",
  initialState,
  reducers: (create) => ({
    /**
     * SSR 首屏：服务端预取公开 Agent 列表后注入，走 __PRELOADED_STATE__ 链路
     */
    setSSRPublicAgents: create.reducer(
      (state, action: PayloadAction<Agent[]>) => {
        state.pubCybots.data = Array.isArray(action.payload) ? action.payload : [];
        state.pubCybots.loading = false;
        state.pubCybots.error = null;
      }
    ),

    /**
     * 通用 LLM 调用（不带 Agent 上下文 / 历史）
     */
    runLlm: create.asyncThunk(async (args: RunLlmArgs, thunkApi) => {
      const overrides: Record<string, any> = {};
      if (args.systemPromptOverride !== undefined) overrides.prompt = args.systemPromptOverride;
      if (args.toolsOverride !== undefined) overrides.tools = args.toolsOverride;
      const { _executeModel } = await import("../agent/_executeModel");
      return _executeModel(
        {
          isStreaming: args.isStreaming ?? false,
          withAgentContext: false,
          withChatHistory: false,
          agentConfigOverrides: Object.keys(overrides).length ? overrides : undefined,
        },
        args,
        thunkApi
      );
    }),

    /**
     * 通用 Agent 调用（带 Agent 上下文，多轮工具循环）
     *
     * 使用客户端 runAgentClientLoop：
     * - 每轮调用 LLM（非流式）
     * - 遇到 tool_calls 时通过 findToolExecutor 本地执行工具
     * - 循环直到无工具调用或触发其他运行时停止条件
     */
    runAgent: create.asyncThunk(async (args: RunAgentArgs, thunkApi) => {
      const { runAgentClientLoop } = await import("../agent/runAgentClientLoop");
      const { content: loopContent, toolCallCount } = await runAgentClientLoop(
        {
          agentKey: args.agentKey,
          content: args.content,
          parentMessageId: args.parentMessageId,
          billingDialogKey: args.billingDialogKey,
        },
        thunkApi
      );
      return loopContent;
    }),

    /**
     * 聊天轮次流式 Agent 调用
     */
    streamAgentChatTurn: create.asyncThunk(async (args: any, thunkApi) => {
      const { streamAgentChatTurnHandler } = await import("../agent/streamAgentChatTurn");
      return streamAgentChatTurnHandler(args, thunkApi);
    }),

    /**
     * 创建 Agent：
     * - 写入用户私有路径
     * - 如 isPublic=true，则同时写入公共路径
     * - 返回完整 Agent 对象（包含 id / meta 字段）
     */
    createAgent: create.asyncThunk(
      async ({ userId, formData, spaceId }: CreateAgentArgs, thunkApi) => {
        const processed = processAgentCreateForm(formData, userId);

        const now = Date.now();
        const id = ulid();

        const privateKey = createAgentKey.private(userId, id);
        const publicKey = createAgentKey.public(id);

        const agent: Agent = {
          ...(processed as any),
          id,
          type: DataType.AGENT,
          userId,
          createdAt: now,
          updatedAt: now,
          dialogCount: 0,
          messageCount: 0,
          tokenCount: 0,
          spaceId: spaceId, // 记录 spaceId
        };

        // 写入私有副本
        await thunkApi
          .dispatch(
            write({
              data: agent,
              customKey: privateKey,
            })
          )
          .unwrap();

        // 如需公开，再写入公共副本
        if (agent.isPublic) {
          await thunkApi
            .dispatch(
              write({
                data: agent,
                customKey: publicKey,
              })
            )
            .unwrap();
        }

        return agent;
      }
    ),

    /**
     * 更新 Agent（支持局部字段 patch）：
     * - patch 私有副本
     * - 如提供 previousAgent，则同步更新 / 删除公共副本
     *
     * 注意：
     * - Tool 场景下一般不提供 previousAgent，此时只保证私有副本被更新；
     *   公共副本（应用市场）不做强一致保证。
     */
    updateAgent: create.asyncThunk(
      async (
        { userId, agentId, formData, previousAgent }: UpdateAgentArgs,
        thunkApi
      ) => {
        const normalizedAgentId = (() => {
          const raw = agentId.trim();
          if (raw.startsWith("agent-") || raw.startsWith("cybot-")) {
            const parts = raw.split("-");
            if (parts.length >= 3) return parts[parts.length - 1];
          }
          return raw;
        })();

        // 【兼容层】双前缀处理：
        // 1. 如果 agentId 是以 cybot- 开头，或者 previousAgent.type 是 cybot，说明这是存量旧数据。
        // 2. 存量数据必须使用 createCybotKey 才能正确定位到数据库中的位置。
        // 3. 新数据则默认使用 createAgentKey (agent- 前缀)。
        let privateKey = createAgentKey.private(userId, normalizedAgentId);
        let publicKey = createAgentKey.public(normalizedAgentId);

        if (agentId.startsWith("cybot-") || previousAgent?.type === "cybot") {
          privateKey = createCybotKey.private(userId, normalizedAgentId);
          publicKey = createCybotKey.public(normalizedAgentId);
        }

        const changes = processAgentUpdateChanges(formData || {}, userId, previousAgent);

        // 1) 检查本地是否存在
        let localExists = false;
        try {
          const { db } = thunkApi.extra as any;
          const localData = await db.get(privateKey);
          localExists = !!localData;
        } catch (e) {
          // ignore
        }

        if (localExists) {
          // 有本地数据，直接 patch
          await thunkApi
            .dispatch(
              patch({
                dbKey: privateKey,
                changes,
              })
            )
            .unwrap();
        } else if (previousAgent) {
          // 无本地数据，但有 UI 传来的 previousAgent，用 write 回填
          const merged = {
            ...previousAgent,
            ...changes,
            id: normalizedAgentId,
            type: previousAgent.type || DataType.AGENT,
            userId,
          };
          await thunkApi
            .dispatch(
              write({
                data: merged,
                customKey: privateKey,
              })
            )
            .unwrap();
        } else {
          // 既无本地也无 previousAgent，尝试标准 path (可能会失败 if remote also fails or path throws)
          // 但既然到了 update，大概率之前 read 过。
          // 兜底调用 patch，让 patch 内部去报错
          await thunkApi
            .dispatch(
              patch({
                dbKey: privateKey,
                changes,
              })
            )
            .unwrap();
        }

        // 2) 如提供 previousAgent，则尝试保持公共副本同步
        if (previousAgent) {
          const wasPublic = !!previousAgent.isPublic;
          const hasIsPublicChange = Object.prototype.hasOwnProperty.call(
            changes,
            "isPublic"
          );
          const nowPublic = hasIsPublicChange
            ? !!(changes as any).isPublic
            : wasPublic;

          if (nowPublic) {
            const mergedPublic: Agent = {
              ...(previousAgent as any),
              ...(changes as any),
              id: normalizedAgentId,
              type: previousAgent.type || DataType.AGENT,
              userId,
            };

            await thunkApi
              .dispatch(
                write({
                  data: mergedPublic,
                  customKey: publicKey,
                })
              )
              .unwrap();
          } else if (wasPublic && !nowPublic) {
            await thunkApi
              .dispatch(remove(publicKey))
              .unwrap();
          }
        }

        // 3) 返回“私有视角”的最新 Agent（主要给前端本地状态使用）
        const base = previousAgent ?? ({} as Partial<Agent>);
        const mergedPrivate: Agent = {
          ...(base as any),
          ...(changes as any),
          id: normalizedAgentId,
          type: base.type || DataType.AGENT,
          userId,
        };

        return mergedPrivate;
      }
    ),
  }),
});

export const {
  runLlm,
  runAgent,
  streamAgentChatTurn,
  createAgent,
  updateAgent,
  setSSRPublicAgents,
} = slice.actions;

const agentReducer: (state: AgentState | undefined, action: any) => AgentState = slice.reducer;

export default agentReducer;

/** 读取 SSR 预载的公开 Agent 列表（首页 AI 广场） */
export const selectSSRPublicAgents = (state: any): Agent[] =>
  state.cybot?.pubCybots?.data ?? [];
