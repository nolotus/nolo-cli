export type AgentRuntimeMode = "local" | "server";
export type AgentRuntimeHost = "cli" | "desktop" | "web" | "server";
export type AgentRuntimeRequestedMode = "auto" | AgentRuntimeMode;

export const AGENT_RUNTIME_MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;

export type AgentRuntimeMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image_url";
          image_url: { url: string };
          google_native?: {
            inlineData: {
              mimeType: string;
              data: string;
            };
            thoughtSignature?: string;
          };
        }
    >
  | null;

export interface AgentRuntimeToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Gemini 3.5 家族要求回放 functionCall 时携带真实的 thoughtSignature，
   * 否则返回 400 或空响应。由 antigravity CCA provider 在流式响应中捕获，
   * 随消息记录持久化，回放时原样带回（缺失时才回退哨兵）。
   */
  thought_signature?: string;
}

export interface AgentRuntimeChatMessage {
  role: (typeof AGENT_RUNTIME_MESSAGE_ROLES)[number];
  content: AgentRuntimeMessageContent;
  tool_call_id?: string;
  tool_calls?: AgentRuntimeToolCall[];
  /** 工具名：tool 行的语义字段，落库 / 回读 / 折叠头显示都依赖它。 */
  toolName?: string;
  tool_result_metadata?: Record<string, unknown>;
  reasoning_content?: string;
  cybotKey?: string;
  agentKey?: string;
  agentName?: string;
}

export type AgentRuntimeOutputBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      toolCall: AgentRuntimeToolCall;
      /**
       * 已填充 = provider 流内已执行（如 Cursor exec 通道），localLoop 不得重跑 executeTool。
       */
      result?: { content: string; metadata?: Record<string, unknown> };
    };

export interface AgentRuntimeResult {
  content: string;
  model: string;
  provider?: string;
  inputPrice?: number;
  outputPrice?: number;
  usage?: Record<string, any>;
  trace?: AgentRuntimeChatMessage[];
  tool_calls?: AgentRuntimeToolCall[];
  reasoning_content?: string;
  runtimeToolNames?: string[];
  runtimeToolSurface?: unknown;
  toolCallCount?: number;
  /**
   * Provider 报告的本次 LLM 调用收尾原因（OpenAI chat.completions 语义）。
   * 典型值："stop"（正常说完）、"length"（撞输出 token 上限被砍断）、
   * "tool_calls"（要求调工具）、"content_filter"。
   *
   * 多轮工具循环里只有最后一轮的值有意义，由 localLoop 透出顶层。
   * 消费方据此区分"话说了一半"与"正常结束"，**不**改变控制流。
   */
  finish_reason?: string;
  /**
   * Canonical 有序 block 输出序列（text/thinking/toolCall 交错）。
   * provider 有此序列时通过 output 返回，localLoop 按 block 消费。
   * OpenAI 兼容 provider 不设此字段（content + tool_calls 扁平模型足够）。
   */
  output?: AgentRuntimeOutputBlock[];
  /** Set when a turn is persisted after a provider/runtime failure. */
  error?: boolean;
  errorMessage?: string;
  policyState?: unknown;
  latencyProfile?: {
    totalMs: number;
    llmRequestCount: number;
    llmWaitMs: number;
    llmJsonParseMs: number;
    toolExecutionMs: number;
    timeToFirstAssistantMs?: number;
    timeToFirstToolResultMs?: number;
    endedAt: number;
  };
}

export type AgentRuntimeDecisionInput = {
  requestedMode?: AgentRuntimeRequestedMode;
  syncRequested?: boolean;
  host?: AgentRuntimeHost;
  hasLocalAgentConfig: boolean;
  hasLocalProvider: boolean;
  hasLocalPersistence: boolean;
  missingLocalCapabilities?: string[];
  requiresServer?: boolean;
  serverFallbackAvailable: boolean;
};

export type AgentRuntimeWorkspaceMode = "none" | "current" | "lease";

export type AgentRuntimeShellPolicy = {
  enabled?: boolean;
  mode?: "off" | "worktree";
  commandPolicy?: "denylist" | "allowlist" | "approval";
  networkPolicy?: "default-deny" | "allowed" | "approval";
  maxOutputBytes?: number;
};

export type AgentRuntimeGitPolicy = {
  canCommit?: boolean;
  canPushAlpha?: boolean;
  canMergeMain?: boolean;
};

export type AgentRuntimeAuditPolicy = {
  logToolCalls?: boolean;
  logShellCommands?: boolean;
  writeToDialog?: boolean;
  writeToTask?: boolean;
};

export type AgentRuntimeIsolationPolicy = {
  mode?: "none" | "os-sandbox" | "container" | "gvisor" | "microvm" | "dedicated-vm";
};

export type AgentRuntimeToolPolicy = {
  version?: 1;
  agentTools?: string[];
  runtimeTools?: string[];
  workspace?: {
    mode?: AgentRuntimeWorkspaceMode;
    writableRoots?: string[];
    cwd?: string;
  };
  shell?: AgentRuntimeShellPolicy;
  isolation?: AgentRuntimeIsolationPolicy;
  git?: AgentRuntimeGitPolicy;
  budget?: {
    dailyUsdLimit?: number;
    maxRunSeconds?: number;
  };
  audit?: AgentRuntimeAuditPolicy;
};

export type AgentRuntimeDecision = {
  mode: AgentRuntimeMode;
  runnable: boolean;
  reason: string;
  missingLocalCapabilities: string[];
  syncAfterRun: boolean;
};
