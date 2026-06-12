// packages/ai/types.ts

export type ModeType =
  | "text"
  | "image"
  | "stream"
  | "audio"
  | "speech"
  | "surf"
  | "vision";

export interface PromptFormData {
  name: string;
  content: string;
  category?: string;
  tags?: string[];
}

export interface Contexts {
  // High priority: context from the user's current input for this request.
  currentInputContext?: string | null;

  // Medium priority: references from past conversation messages.
  historyContext?: string | null;

  // Specific rules and processes for the bot/agent.
  botInstructionsContext?: string | null;

  // General knowledge base documents for lookup.
  botKnowledgeContext?: string | null;

  // 🔹 新增：用户级通用提示词
  userGlobalPrompt?: string;

  /** 当前正在编辑的对象描述（表格 / 页面 / 文章等），由 buildEditingContextSummary 构造 */
  editingContext?: string | null;

  /** 当前对话里最近一次 app 相关工具调用提炼出的工作记忆，不依赖右侧 editing target */
  appWorkingMemory?: string | null;

  /** 当前所在的 Space 信息（Agent 所处的工作台），包含标题、描述等 */
  spaceContext?: string | null;

  /** 用户偏好与自动化边界（tone / capture / read policy） */
  userPolicyContext?: string | null;

  /** 长期记忆召回层，由服务端 memory API 基于当前用户、space、agent 和输入生成 */
  memoryOverlay?: string | null;

  /** 对话增量摘要：已压缩的历史消息概要 */
  dialogSummary?: string | null;

  /** 主动工作摘要：阶段性沉淀，不代表原始消息已被裁剪 */
  proactiveSummary?: string | null;

  /** 压缩消息中提取的引用 Key */
  referenceKeys?: string[];
}
