// 文件路径: chat/messages/types.ts

// ========== 角色 ==========
export type MessageRole = "user" | "system" | "assistant" | "tool";

// ========== OpenAI 风格的 content ==========
export type OpenAIImageUrl =
  | `http${string}`
  | `https${string}`
  | `data:image/${string};base64,${string}`;

export interface OpenAIImageContent {
  type: "image_url";
  image_url: {
    url: OpenAIImageUrl;
    detail?: "low" | "high" | "auto";
  };
  google_native?: {
    inlineData?: {
      mimeType: string;
      data: string;
    };
    thoughtSignature?: string;
  };
}

export interface OpenAITextContent {
  type: "text";
  text: string;
}

export type MessageContentPart = OpenAITextContent | OpenAIImageContent;

export type CompletionFinishReason = "stop" | "tool_calls" | "length" | "content_filter" | null;

// ========== Token Usage ==========
export interface CompletionUsage {
  completion_tokens: number;
  prompt_tokens: number;
  total_tokens: number;
  cost?: number; // OpenRouter extension
  prompt_tokens_details?: Record<string, any>;
  completion_tokens_details?: Record<string, any>;
  cost_details?: Record<string, any>;
  /** Platform billing identity when usage is rated into credits. */
  billing_provider?: string;
  billing_model?: string;
}

export type Content = string | MessageContentPart[];

export interface ImageGenerationState {
  kind: "image_generation";
  stage: "submitted" | "generating" | "saving";
  startedAt: number;
  waitHint?: string;
  profileLabel?: string;
}

// ========== 消息级 UI 选项（Agent 菜单 / 快速回复 等） ==========

export type UiOptionSource = "agent_menu" | "llm" | "system" | "tool";

export interface UiOptionMeta {
  /** 选项来源：Agent 配置 / LLM 建议 / 系统内置 / Tool 生成 */
  source?: UiOptionSource;
  /** 可选描述：用于 tooltip 或 hover 展示的详细说明 */
  description?: string;
}

/**
 * 一条消息下方的可点击选项（Agent 菜单 / quick reply / Tool 提示等）
 * - 显示给用户的是 label
 * - 发给 LLM 的是 userMessage（如果不写则使用 label）
 */
export interface UiOption {
  /** 选项自身的稳定 ID（和 message.id 不同） */
  id: string;
  /** 按钮上的文案（用户可见） */
  label: string;
  /** 点击后要发给 LLM 的“等价人话”，不填则默认用 label */
  userMessage?: string;
  /** 附加元信息（目前轻量使用，后续可以扩展） */
  meta?: UiOptionMeta;
}

// ========== Tool 调用快照 ==========

export interface ToolErrorPayload {
  type: string;
  message: string;
  code?: string;
  retryable?: boolean;
}

export interface ProcessLaunchInfo {
  pid: number;
  label: string;
  command: string;
  status: "running" | "stopped" | "exited" | "failed";
  startedAt?: number;
  exitCode?: number;
}

export interface ToolPayload {
  toolName: string;
  status: "pending" | "running" | "succeeded" | "failed";
  input: any;
  rawToolCall?: any;

  /**
   * ✅ 工具输出不在 toolPayload 存储（唯一输出来源是 message.content）
   * rawResult 不再写入；这里不保留兼容字段，按你的要求直接干掉。
   */

  error?: ToolErrorPayload;
  toolRunId?: string;
  startedAt?: number;
  finishedAt?: number;

  /**
   * ✅ 持久化摘要：用于 ToolMessageItem header 展示
   * 没有的话 UI 会 fallback 默认文案
   */
  summary?: string;

  /**
   * Human-readable tool activity hint for UI projection.
   * Execution output remains in message.content; this is display metadata only.
   */
  activity?: unknown;

  /**
   * 提供给下一轮 LLM 的结构化上下文补充。
   * 典型场景：工具真实产物（如 fileId / 可复用 URL）不能只靠 summary 传达。
   * UI 不直接展示它，避免把 header 摘要污染成长文本。
   */
  llmContext?: string;

  /**
   * callAgent 子任务完成后产生的独立 dialog ID
   * 供 UI 渲染「查看完整对话 →」跳转链接
   */
  subDialogId?: string;

  /**
   * 可选（未来建议）：toolVersion / executorVersion，用于严格复现
   * toolVersion?: string;
   */

  /** launchProcess 启动的后台进程信息。独立于 toolRun 状态机：
   *  工具调用本身是 succeeded（立即返回），但进程后续可 running→stopped→exited 流转。 */
  processLaunch?: ProcessLaunchInfo;
}

// ========== Message 主类型 ==========

export interface Message {
  role: MessageRole;
  content: Content;

  thinkContent?: string;
  image?: string;
  images?: string[];

  id: string;
  dbKey: string;

  cybotId?: string;
  cybotKey?: string;
  agentKey?: string;
  agentName?: string;

  isStreaming?: boolean;
  imageGenerationState?: ImageGenerationState;
  userId?: string;
  usage?: any;
  metadata?: Record<string, unknown>;

  controller?: AbortController;

  // ========= Tool 扩展字段 =========

  toolName?: string;
  toolPayload?: ToolPayload;
  parentMessageId?: string;
  toolRunId?: string;

  // tool_call_id：关联 assistant message 的 tool_calls[].id
  toolCallId?: string;

  // assistant message 的 tool_calls（OpenAI 标准字段名）
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;

  // ========= 消息级 UI 选项（Agent 菜单 / quick reply） =========
  options?: UiOption[];
}
