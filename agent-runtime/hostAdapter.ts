import type {
  AgentRuntimeChatMessage,
  AgentRuntimeHost,
  AgentRuntimeResult,
  AgentRuntimeToolPolicy,
} from "./types";

export type AgentRuntimeAgentConfig = {
  key: string;
  name?: string;
  prompt?: string;
  model?: string;
  provider?: string;
  apiSource?: string;
  cliProvider?: string;
  customProviderUrl?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  apiKeyFromAgentKey?: string;
  apiKeyRef?: string;
  /** Broker ref for local-first secrets (never a raw API key). */
  credentialRef?: string;
  /** Whether the custom api-key is synced to the user's server account (fallback source). */
  credentialSynced?: boolean;
  useServerProxy?: boolean;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  /** Explicit tool names from agent record / form config. */
  toolNames?: string[];
  /**
   * Tool names actually exposed to the model this run, after the host drops
   * names it has no executor for.
   *
   * `toolNames` is what the agent *declares*; hosts implement different
   * subsets (the CLI has no `read`/`createDoc` executor, for instance). Prompt
   * guidance must key off this list, not the declared one — otherwise the
   * system prompt describes tools the model cannot see, which is exactly how
   * `rememberMemory` came to be advertised in the TUI while being absent from
   * the schema. Hosts that expose everything they declare may leave it unset.
   *
   * Caveat worth knowing before you rely on it: consumers fall back to
   * `toolNames` when this is absent, and `toolNames` is the list that caused
   * the original bug. A host that filters its tools but forgets to report the
   * survivors silently gets the old broken behavior back rather than an error.
   * The fallback exists because most hosts genuinely expose everything they
   * declare; if that stops being true, make this required instead.
   *
   * That has now stopped being true: the desktop host narrows its tool surface
   * (narrowDesktopNoloToolsForTurn, tier-agent branches, systemBuiltinSkills
   * filter, disabledTools) but never sets this field, so its guidance is built
   * from the declared list. Making the field required is not enough on its own
   * to fix it — desktop does that narrowing inside `resolveProvider`, which
   * localLoop calls *after* it has already built the guidance blocks
   * (localLoop.ts: loadAgentConfig → guidance → resolveProvider). Closing the
   * gap means hoisting the narrowing into `loadAgentConfig` first; only then
   * can this field be made required without desktop having nothing to report.
   */
  exposedToolNames?: string[];
  runtimeBinding?: Record<string, unknown>;
  runtimeToolPolicy?: AgentRuntimeToolPolicy;
  delegation?: Record<string, unknown>;
  rawRecord?: Record<string, unknown>;
};

export type AgentRuntimeCompleteOptions = {
  timeoutMs?: number;
  /**
   * 本轮所属对话 id。仅用于服务端计费归因：platform proxy 会把它写进
   * token 记录的 dialogId（缺省时 chatProxyBilling 兜底成 "chat-proxy"，
   * 所有 runtime 调用会塌成同一个桶），kimi 路径还会据此设 prompt_cache_key。
   * 不会转发给上游 provider。新建对话的首轮尚未分配 id，此时为 undefined。
   */
  dialogId?: string;
  onTextDelta?: (chunk: string) => void;
  /**
   * reasoning 增量回调（第一层透传）。provider 在 SSE 读取路径收到
   * reasoning 增量时回调；与 onTextDelta 同模式。localLoop 把 input
   * 上的 onReasoningDelta 透传到这里。
   */
  onReasoningDelta?: (chunk: string) => void;
  /**
   * Mid-stream tool event callback. Providers that execute tools inline
   * during the stream (e.g. Cursor's exec channel) call this at the moment
   * a tool is invoked / resolves, so CLI/Desktop can interleave
   * text→tool→text instead of deferring all tool cards to after the stream.
   * Same shape as localLoop's `LocalAgentToolEvent`; localLoop forwards its
   * own `onToolEvent` here and suppresses duplicate emission for inline
   * output blocks.
   */
  onToolEvent?: (event: {
    type: "tool-call" | "tool-result" | "tool-error";
    round: number;
    toolCallId: string;
    toolName: string;
    argumentsPreview?: string;
    elapsedMs?: number;
    summary?: string;
    content?: string;
    message?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  /** Round number for `onToolEvent` events; localLoop sets it to current round. */
  toolEventRound?: number;
};

export type AgentRuntimeProvider = {
  model: string;
  complete(
    messages: AgentRuntimeChatMessage[],
    options?: AgentRuntimeCompleteOptions
  ): Promise<AgentRuntimeResult>;
};

export type AgentRuntimeToolCallInput = {
  id: string;
  name: string;
  arguments: string;
  userInput?: string;
  /** Host-injected turn context; never supplied by the model. */
  runtimeContext?: Record<string, any> | null;
};

export type AgentRuntimeToolResult = {
  content: string;
  metadata?: Record<string, unknown>;
};

export type AgentRuntimeSaveTurnInput = {
  agentKey: string;
  messages: AgentRuntimeChatMessage[];
  result: AgentRuntimeResult;
  /**
   * Individual provider calls made during the turn. Billing must consume
   * these records instead of the aggregate result usage because a tool loop
   * can contain several independently billed/idempotent upstream calls.
   */
  usageRecords?: Array<{
    /** Stable for retries of this saved turn; provider_call_id when available. */
    callId: string;
    usage: Record<string, unknown>;
    model: string;
    provider?: string;
  }>;
  /** Full token consumption across tool-loop and compaction provider calls. */
  accountingUsage?: Record<string, unknown>;
  /** Billing identity resolved from the agent record (never includes secrets). */
  billingConfig?: {
    model: string;
    provider?: string;
    apiSource?: string;
    apiKeyRef?: string | null;
    inputPrice?: number;
    outputPrice?: number;
    sharingLevel?: "default" | "split" | "full";
    id?: string;
    userId?: string;
  };
  runtimeContext?: Record<string, any> | null;
  continueDialogId?: string;
  spaceId?: string;
  category?: string;
  inheritedFromDialogKey?: string;
  parentDialogId?: string;
};

export type AgentRuntimeDialogSummary = {
  summary: string;
  summarizedBeforeId?: string;
};

export type AgentRuntimeHostAdapter = {
  host: AgentRuntimeHost;
  capabilities: string[];
  loadAgentConfig(agentRef: string): Promise<AgentRuntimeAgentConfig | null>;
  loadDialogHistory(dialogId: string): Promise<AgentRuntimeChatMessage[]>;
  saveTurn(input: AgentRuntimeSaveTurnInput): Promise<{
    dialogId: string;
    title?: string;
    /**
     * 后台 LLM 标题 patch（fire-and-forget，不阻塞 turn 返回）。resolve 时
     * 携带 patch 成功的最终标题；无标题/被跳过/失败为 null。长驻宿主（如
     * TUI）用它刷新窗口标题（OSC）而不必等下一轮 turn 才看到总结标题。
     */
    titlePatchPromise?: Promise<string | null>;
  }>;
  resolveProvider(agentConfig: AgentRuntimeAgentConfig): Promise<AgentRuntimeProvider>;
  executeTool(
    call: AgentRuntimeToolCallInput,
    opts?: {
      abortSignal?: AbortSignal;
      runtimeContext?: Record<string, any> | null;
    },
  ): Promise<AgentRuntimeToolResult>;
  /**
   * Optional: load a persisted dialog summary for local auto-compaction.
   * Missing method = host does not support auto-compaction (behavior unchanged).
   */
  loadDialogSummary?(
    dialogId: string,
  ): Promise<AgentRuntimeDialogSummary | null>;
  /**
   * Optional: persist a dialog summary generated at a compression point.
   * Must only be called when a new summary is produced — never per-turn rewrite.
   */
  saveDialogSummary?(input: {
    dialogId: string;
    summary: string;
    summarizedBeforeId?: string;
  }): Promise<void>;
};

export function createRuntimeHostDescriptor(adapter: AgentRuntimeHostAdapter) {
  return {
    host: adapter.host,
    capabilities: [...adapter.capabilities],
  };
}
