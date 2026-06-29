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
}

export interface AgentRuntimeChatMessage {
  role: (typeof AGENT_RUNTIME_MESSAGE_ROLES)[number];
  content: AgentRuntimeMessageContent;
  tool_call_id?: string;
  tool_calls?: AgentRuntimeToolCall[];
  tool_result_metadata?: Record<string, unknown>;
  reasoning_content?: string;
  cybotKey?: string;
  agentKey?: string;
  agentName?: string;
}

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
