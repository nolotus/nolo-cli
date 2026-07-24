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
  runtimeBinding?: Record<string, unknown>;
  runtimeToolPolicy?: AgentRuntimeToolPolicy;
  delegation?: Record<string, unknown>;
  rawRecord?: Record<string, unknown>;
};

export type AgentRuntimeCompleteOptions = {
  timeoutMs?: number;
  onTextDelta?: (chunk: string) => void;
  /**
   * reasoning 增量回调（第一层透传）。provider 在 SSE 读取路径收到
   * reasoning 增量时回调；与 onTextDelta 同模式。localLoop 把 input
   * 上的 onReasoningDelta 透传到这里。
   */
  onReasoningDelta?: (chunk: string) => void;
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
};

export type AgentRuntimeToolResult = {
  content: string;
  metadata?: Record<string, unknown>;
};

export type AgentRuntimeSaveTurnInput = {
  agentKey: string;
  messages: AgentRuntimeChatMessage[];
  result: AgentRuntimeResult;
  runtimeContext?: Record<string, any> | null;
  continueDialogId?: string;
  spaceId?: string;
  category?: string;
  inheritedFromDialogKey?: string;
  parentDialogId?: string;
};

export type AgentRuntimeHostAdapter = {
  host: AgentRuntimeHost;
  capabilities: string[];
  loadAgentConfig(agentRef: string): Promise<AgentRuntimeAgentConfig | null>;
  loadDialogHistory(dialogId: string): Promise<AgentRuntimeChatMessage[]>;
  saveTurn(input: AgentRuntimeSaveTurnInput): Promise<{ dialogId: string }>;
  resolveProvider(agentConfig: AgentRuntimeAgentConfig): Promise<AgentRuntimeProvider>;
  executeTool(call: AgentRuntimeToolCallInput): Promise<AgentRuntimeToolResult>;
};

export function createRuntimeHostDescriptor(adapter: AgentRuntimeHostAdapter) {
  return {
    host: adapter.host,
    capabilities: [...adapter.capabilities],
  };
}
