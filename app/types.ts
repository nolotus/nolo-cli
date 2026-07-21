// packages/app/types.ts
import type { UiOption, OpenAIImageContent } from "../chat/messages/types";
import { DataType } from "../create/types";
import type {
  AgentBasePolicy,
  DialogPolicyState,
} from "../ai/policy/types";

export type ULID = string;

export type DialogRuntimeController =
  | "request"
  | "scheduler"
  | "server-supervisor"
  | "external-supervisor";

export type DialogRuntimeProfile = "autonomous";

export interface DialogNotificationPolicy {
  notifyOnDone?: boolean;
  notifyOnFailed?: boolean;
  channels?: Array<"ui" | "email">;
}

export interface DialogRuntimeBinding {
  version: 1;
  /** 当前 product runtime 的 tenant 边界；本地模型 watchdog 不属于这里。 */
  tenantUserId?: string | null;
  agentKey: string;
  /** 当前长期 runtime 的 durable anchor；现阶段直接复用 dialog。 */
  runtimeAnchorDialogId: string;
  controller: DialogRuntimeController;
  triggerType?: "user" | "api" | "localhost" | "scheduled_run" | "automation_run";
  executionMode?: "foreground" | "background";
  runtimeProfile?: DialogRuntimeProfile;
  spaceId?: string;
  category?: string;
  /** Effective runtime/tool policy snapshot for this dialog run. */
  runtimeToolPolicySnapshot?: Record<string, unknown>;
  /** Workspace lease/session used by machine or workspace-backed tools. */
  workspaceLease?: Record<string, unknown>;
}

export interface AgentRuntimeBinding {
  machineId?: string | null;
  ownerUserId?: string | null;
  requiredCapabilities?: string[] | null;
  runtimeToolPolicy?: Record<string, unknown> | null;
}

export interface DialogGoalState {
  objective: string;
  status: "active" | "complete";
  tokenBudget?: number;
  createdAt: number;
  completedAt?: number;
}

export interface DialogSubjectRef {
  kind: "table-row" | "page" | "dialog" | "asset" | "external" | string;
  id: string;
  role?: "subject" | "parent" | "assignment" | "artifact" | string;
}

export interface DialogConfig {
  id: string; // 对话的唯一标识符/路径
  type: DataType.DIALOG; // 数据类型标记
  title: string; // 对话标题
  cybots: string[]; // 兼容字段：当前对话参与的 agent ID 列表
  primaryAgentKey?: string;
  taskLabel?: string;
  tags?: string[];
  createdAt: string; // 创建时间戳
  updatedAt: string; // 最后更新时间戳
  dbKey?: string;
  /** 对话级临时挂载的引用（skill/instruction/knowledge），与 agent.references 同语义，随对话生效 */
  extraReferences?: ReferenceItem[];
  spaceId?: string;
  category?: string;

  // --- 上下文压缩 ---
  summary?: string; // 对话摘要（单层覆盖式）
  summarizedBeforeId?: string; // 摘要覆盖到哪条消息 ID
  proactiveSummary?: string; // 主动工作摘要（不裁剪原始消息，供被动压缩消费）
  proactiveSummaryBeforeId?: string; // 主动工作摘要覆盖到哪条消息 ID
  compressionCount?: number; // 压缩次数（用于极端情况提示）
  referenceKeys?: string[]; // 消息中引用过的 pageKey/dialogKey（替代 historyKeys 扫描）
  inheritedFromDialogKey?: string; // 若从旧对话开启，记录来源对话 key 以便刷新后仍可提示
  inheritedFromDialogTitle?: string; // 来源对话标题快照，用于 UI 提示
  summaryPending?: boolean; // 摘要任务是否挂起（因快速切换等原因）
  inputTokens?: number;
  outputTokens?: number;
  maxTokens?: number; // 此对话最大回复 token 数，覆盖 agent 默认值

  // --- 执行模式（API/后台/定时场景扩展，前台对话不填） ---
  /** 谁触发的：user=用户前台输入 api=外部API调用 localhost=本机调用 automation_run=自动化运行 */
  triggerType?: "user" | "api" | "localhost" | "scheduled_run" | "automation_run";
  /** foreground=用户等结果(流式) background=后台静默执行 */
  executionMode?: "foreground" | "background";
  /** 仅 background/scheduled 场景有意义 */
  status?: "pending" | "running" | "done" | "failed" | "cancelled";
  scheduledAt?: number;    // 定时任务预定执行时间戳
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  toolCallCount?: number;
  totalCost?: number;
  cliSessionId?: string;
  /** multi-agent: 当前 dialog 由哪个父 dialog 发起 */
  parentDialogId?: string;
  /** multi-agent: 这棵 dialog 执行树的根 dialog，便于查询 fanout */
  rootDialogId?: string;
  /** 当前 dialog 关联的业务对象；保持行业中立，不只服务任务表 */
  subjectRefs?: DialogSubjectRef[];
  /** Legacy scheduled task run parent. New automation runs use parentAutomationKey plus subjectRefs. */
  parentTaskKey?: string;
  /** 自动化运行产生的对话归属的 automation key；关联真值仍是 subjectRefs。 */
  parentAutomationKey?: string;
  /** 定时任务去重 key */
  idempotencyKey?: string;
  /** cron 表达式，用于重复执行，如 "0 2 * * *" */
  schedule?: string;
  /** 定时任务执行的指令（不同于对话内容，是固定的任务描述） */
  taskPrompt?: string;
  policyState?: DialogPolicyState;
  runtimeBinding?: DialogRuntimeBinding;
  goal?: DialogGoalState;
  notificationPolicy?: DialogNotificationPolicy;
  /**
   * 对话完成/失败后写入的时间戳，驱动侧边栏未读点。进入对话即清零。
   * 服务端在 dialog.done/failed 时写入；客户端 markDialogRead 时 patch 为 null。
   * 不同于运行态 status（实时、易变），unreadAt 只在终态产生，进入即清除。
   */
  unreadAt?: number | null;
}

export interface ScheduledTaskConfig {
  id: string;
  dbKey: string;
  type: DataType.TASK;
  title: string;
  agentKey: string;
  cybots: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  spaceId?: string;
  status: "active" | "paused" | "cancelled";
  runStatus?: "idle" | "running" | "done" | "failed";
  schedule: string;
  taskPrompt: string;
  nextRunAt: number;
  lastRunAt?: number;
  lastRunDialogKey?: string;
  lastRunError?: string;
  runDialogKeys?: string[];
}

export type AgentAutomationTrigger =
  | {
      type: "cron";
      expression: string;
      timezone?: string;
      nextWakeAt: number;
    };

export interface AgentAutomationConfig {
  id: string;
  dbKey: string;
  type: DataType.AGENT_AUTOMATION;
  title: string;
  ownerAgentKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  spaceId?: string;
  status: "active" | "paused" | "cancelled" | "completed";
  runStatus?: "idle" | "running" | "done" | "failed";
  instruction: string;
  subjectRefs?: DialogSubjectRef[];
  trigger: AgentAutomationTrigger;
  notifyPolicy?: unknown;
  stopPolicy?: unknown;
  lastRunAt?: number;
  lastRunThreadId?: string;
  lastRunDialogKey?: string;
  lastRunError?: string;
}
export type ReferenceItem = {
  dbKey: string;
  title: string;
  type: "knowledge" | "instruction";
};


export interface AgentGreetingMenuItem extends UiOption {
  /** 以后如果想在 UI 上做分组，可以用 group；现在先不实现 UI */
  group?: string;
}


/**
 * Agent 的富 greeting：
 * - text: 打招呼文案（markdown）
 * - menu: 初始菜单项（会显示成第一条消息下方的按钮）
 */
export interface AgentGreetingConfig {
  text?: string;
  menu?: AgentGreetingMenuItem[];
}



export type PublicImageAgentMode = "generate" | "edit" | "continuous";

export interface Agent {
  /**
   * Image workflow mode for this agent.
   * - generate: text-to-image
   * - edit: image editing
   * - continuous: multi-step/interactive image workflows
   */
  imageWorkflow?: PublicImageAgentMode;
  // --- 你已有的所有字段 ---
  provider: string;
  model: string;
  imageModel?: string;
  /** 执行来源：platform=平台API  custom=自定义API/本地  cli=命令行工具 */
  apiSource?: "platform" | "custom" | "cli";
  /** cli 时指定使用哪个 CLI 工具。CLI 可复用 prompt/model/最近文本历史，但不走本地 tool 协议。 */
  cliProvider?: "copilot" | "gemini" | "codex" | "claude" | "agy" | "qoder" | "opencode" | "grok" | "kimi";
  prompt?: string;
  name?: string;
  /** Stable machine-callable name for routing, e.g. "pm", "fullstack", "reviewer". */
  handle?: string;
  [key: string]: any;
  tools?: string[];
  userId: string;
  useServerProxy: boolean;
  apiKey?: string;
  apiKeyRef?: string;
  apiKeyHeader?: string;
  apiKeyFromAgentKey?: string;
  /** Whether the custom api-key is synced to the user's server account (optional sync opt-in). */
  credentialSynced?: boolean;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  max_tokens?: number;
  reasoning_effort?: string;
  enableThinking?: boolean;
  thinkingBudget?: number;
  updatedAt: string;
  createdAt: number;
  categoryId?: string;
  spaceId?: string;
  references?: ReferenceItem[];
  tags?: string[];
  tokenCount?: number;
  messageCount?: number;
  dialogCount?: number;
  outputPrice?: number;
  inputPrice?: number;
  introduction?: string;
  cover?: string;
  greeting?: string | AgentGreetingConfig; // ✅ 这里改成联合类型
  isPublic: boolean;
  endpointKey?: string;


  imageConfig?: {
    enabled?: boolean;
    aspectRatio?:
    | "1:1"
    | "2:3"
    | "3:2"
    | "3:4"
    | "4:3"
    | "4:5"
    | "5:4"
    | "9:16"
    | "16:9"
    | "21:9";
    imageSize?: "1K" | "2K" | "4K";
    forceModalities?: Array<"text" | "image">;
  };

  whitelist?: string[];

  // Cross-Space Context: 关联的其他 Space ID 列表
  // Agent 可以访问这些 Space 的内容作为粗略上下文
  linkedSpaces?: string[];
  basePolicy?: AgentBasePolicy;
  runtimeBinding?: AgentRuntimeBinding | null;
  runtimeToolPolicy?: Record<string, unknown> | null;
}



// --- 内容相关 (核心修改处) ---

export interface SpaceContent {
  title: string;
  type: ContentType;
  contentKey: string; // 唯一标识符 (通常是 dbKey)
  fileCategory?: FileCategory;
  mimeType?: string;
  fileSize?: number;
  originalName?: string;

  // --- 修改: categoryId 变为可选 ---
  categoryId?: string | null; // 属性不存在或值为 undefined/null 代表未分类

  pinned: boolean;
  createdAt: number; // 时间戳 (number)
  updatedAt: number; // 时间戳 (number)
  order?: number; // 分类内排序
  tags?: string[]; // 保留 tags 字段
  triggerType?: string;
  parentTaskKey?: string;
  parentAutomationKey?: string;
  skillSummary?: {
    isSkill: true;
    skillId?: string;
    name?: string;
    description?: string;
    toolNames?: string[];
    triggerMode?: "explicit" | "required" | "recommended";
  } | null;
} // --- 主数据结构 (SpaceData 保持不变) ---

export interface SpaceData {
  id: ULID;
  name: string;
  description: string;
  ownerId: string;
  visibility: SpaceVisibility;
  members: string[]; // userId 列表
  categories: Categories;
  contents: Contents;
  boundFolder?: string;
  createdAt: number;
  updatedAt: number;
  type?: DataType;
}
export enum ContentType {
  DIALOG = "dialog",
  DOC = "page",
  FILE = "file",
  IMAGE = "image",
  AGENT = "agent",
  APP = "app",
  TASK = "task",
  TABLE = "table",
} // --- 枚举 (保持不变) ---
export type FileCategory =
  | "image"
  | "document"
  | "video"
  | "audio"
  | "other";
export enum SpaceVisibility {
  PRIVATE = "private",
  PUBLIC = "public",
}
export enum MemberRole {
  OWNER = "owner",
  ADMIN = "admin",
  MEMBER = "member",
  GUEST = "guest",
}
export type Categories = Record<string, Category | null>; // --- 分类相关 (Category, Categories 保持不变) ---
export interface Category {
  name: string;
  order: number;
  updatedAt: number | string;
} // --- 成员相关 (SpaceMember, SpaceMemberWithSpaceInfo 保持不变) ---

export interface SpaceMember {
  role: MemberRole;
  joinedAt: number;
  updatedAt?: number;
  userId: string;
  spaceId: string;
} // Contents 类型保持不变 (Record<string, SpaceContent | null>)
export type Contents = Record<string, SpaceContent | null>;
export interface SpaceMemberWithSpaceInfo {
  userId: string;
  role: MemberRole;
  joinedAt: number;
  memberUpdatedAt?: number | string;
  dbKey?: string;
  spaceId: string;
  spaceName: string;
  ownerId: string;
  visibility: SpaceVisibility;
  spaceCreatedAt?: number | string;
  spaceUpdatedAt?: number | string;
  createdAt?: number | string;
  updatedAt?: number | string;
  type?: DataType;
}

type MessageContentPartText = { type: "text"; text: string };
type MessageContentPartImageUrl = OpenAIImageContent;

type MessageContentPart = MessageContentPartText | MessageContentPartImageUrl;

export interface Message {
  id?: string;
  role: "user" | "assistant" | "system" | "tool" | "developer";
  content: string | MessageContentPart[];
  name?: string;
  tool_calls?: any;
  tool_call_id?: string;
  userId?: string;
}

// Share types re-exported from share/types
export type { ShareType, SharedObject, ShareMeta, ShareSummary } from "../share/types";
