import { isRecord } from "../../../core/isRecord";
import { asOptionalFiniteNumber } from "../../../core/optionalNumber";
import { asOptionalTrimmedString } from "../../../core/optionalString";
import { asTrimmedString } from "../../../core/trimmedString";
import { asOptionalJsonRecord } from "../parseJsonRecord";

/**
 * Locale-independent display labels (zh defaults). Used when i18n misses a key
 * or returns the raw API name / key path — never show listFiles/execShell bare.
 */
const TOOL_DISPLAY_NAME_DEFAULTS: Record<string, string> = {
  tool: "工具",
  listFiles: "浏览目录",
  list_files: "浏览目录",
  globFiles: "查找文件",
  glob_files: "查找文件",
  searchFiles: "搜索代码",
  search_files: "搜索代码",
  readFile: "读取文件",
  read_file: "读取文件",
  writeFile: "写入文件",
  write_file: "写入文件",
  editFile: "修改文件",
  edit_file: "修改文件",
  execShell: "运行命令",
  exec_shell: "运行命令",
  shell: "运行命令",
  searchWorkspace: "搜索工作区",
  readWorkspaceFile: "读取文件",
  writeWorkspaceFile: "写入文件",
  replaceWorkspaceText: "替换文本",
  listAgents: "列出助手",
  readAgent: "读取助手",
  callAgent: "调用助手",
  exa_search: "搜索",
  firecrawl_scrape: "网页抓取",
  firecrawl_search: "网页搜索",
  startPreview: "启动预览",
  getPreviewStatus: "预览状态",
  stopPreview: "停止预览",
  releasePreview: "释放预览",
  captureVisualState: "截图检查",
};

/** Strip provider prefixes and normalize casing for known tools. */
export function normalizeToolNameKey(toolName: string | undefined): string {
  let normalized = asTrimmedString(toolName);
  if (!normalized) return "";
  normalized = normalized.replace(/^functions\./, "").replace(/^tools\./, "");
  if (TOOL_DISPLAY_NAME_DEFAULTS[normalized]) return normalized;
  // snake_case → camelCase for known tools (list_files → listFiles)
  if (normalized.includes("_")) {
    const camel = normalized.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (TOOL_DISPLAY_NAME_DEFAULTS[camel]) return camel;
  }
  return normalized;
}

/**
 * Resolve a user-facing tool label.
 * Always prefers a real human label over raw API names like `listFiles`.
 */
export function resolveToolDisplayName(
  toolName: string | undefined,
  translate?: (key: string, fallback: string) => string
) {
  const normalized = normalizeToolNameKey(toolName);
  if (!normalized) {
    const fallback = TOOL_DISPLAY_NAME_DEFAULTS.tool;
    return translate ? translate("toolNames.tool", fallback) : fallback;
  }

  const fallback = TOOL_DISPLAY_NAME_DEFAULTS[normalized] ?? normalized;
  if (!translate) return fallback;

  const translated = asTrimmedString(translate(`toolNames.${normalized}`, fallback));
  // i18n miss: returns key path, empty string, or the raw API name.
  if (
    !translated ||
    translated === `toolNames.${normalized}` ||
    translated === normalized ||
    translated === toolName
  ) {
    return fallback;
  }
  // Old zh string still cached somewhere — prefer the clearer default.
  if (normalized === "execShell" && (translated === "命令行" || translated === "命令列")) {
    return fallback;
  }
  return translated;
}

/**
 * Build a translate fn for react-i18next `t` that always passes defaultValue.
 * `t(key, string)` is unreliable across i18next versions.
 */
export function createToolNameTranslator(
  t: (key: string, options?: Record<string, unknown> | string) => string
): (key: string, fallback: string) => string {
  return (key, fallback) => {
    try {
      const value = t(key, { defaultValue: fallback });
      return typeof value === "string" && value.trim() ? value : fallback;
    } catch {
      return fallback;
    }
  };
}

/** Legacy long version labels → short UI titles (also for persisted activity). */
const LEGACY_VERSION_ACTIVITY_TITLES: Record<string, string> = {
  用版本管理检查改动: "检查改动",
  用版本管理查看改动: "查看改动",
  用版本管理查看历史: "查看历史",
  用版本管理暂存改动: "暂存",
  用版本管理保存改动: "提交",
  用版本管理同步改动: "推送",
};

/** Shorten verbose version-control activity titles for tool headers. */
export function shortenActivityTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return trimmed;
  const mapped = LEGACY_VERSION_ACTIVITY_TITLES[trimmed];
  if (mapped) return mapped;
  if (trimmed.startsWith("用版本管理")) {
    const rest = trimmed.slice("用版本管理".length).trim();
    return rest || trimmed;
  }
  return trimmed;
}

export function formatToolInvocationSummary(
  messages: Array<{ toolName?: string }>,
  translate: (key: string, fallback: string) => string
) {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    const name = msg.toolName || "tool";
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([name, count]) => `${resolveToolDisplayName(name, translate)} × ${count}`)
    .join("、");
}

/**
 * Collapsed group header: prefer human activity titles ("浏览目录 × 8")
 * over opaque tool API names ("listFiles × 8"). Falls back to
 * formatToolInvocationSummary when no activity can be derived.
 */
export function formatToolGroupHeaderSummary(
  messages: Array<{
    toolName?: string;
    metadata?: Record<string, unknown>;
    content?: string;
    toolPayload?: Record<string, unknown>;
  }>,
  translate: (key: string, fallback: string) => string
): string {
  const counts = new Map<string, number>();

  for (const msg of messages) {
    const activity = readMessageActivity(msg);
    const activityTitle = asOptionalTrimmedString(
      activity?.action?.title ?? activity?.title
    );
    if (activityTitle) {
      const shortTitle = shortenActivityTitle(activityTitle);
      counts.set(shortTitle, (counts.get(shortTitle) || 0) + 1);
      continue;
    }
    const toolLabel = resolveToolDisplayName(msg.toolName || "tool", translate);
    counts.set(toolLabel, (counts.get(toolLabel) || 0) + 1);
  }

  if (counts.size === 0) {
    return formatToolInvocationSummary(messages, translate);
  }

  // Activity titles are already localized / human; keep order of first appearance.
  return Array.from(counts.entries())
    .map(([label, count]) => `${label} × ${count}`)
    .join("、");
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function extractToolCallArgs(toolPayload?: Record<string, unknown> | null):
  | Record<string, unknown>
  | undefined {
  if (isRecord(toolPayload?.input)) {
    return toolPayload.input as Record<string, unknown>;
  }

  const rawArguments = toolPayload?.rawToolCall;
  if (isRecord(rawArguments)) {
    const fn = rawArguments.function;
    if (isRecord(fn)) {
      const argumentsText = asTrimmedString(fn.arguments);
      if (argumentsText) {
        const parsed = asOptionalJsonRecord(argumentsText);
        if (parsed) return parsed;
      }
    }
  }

  return undefined;
}

export function formatToolRowHeaderSummary(args: {
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
  existingSummary?: string | null;
  translate?: (key: string, fallback: string) => string;
}): string {
  const translate = args.translate ?? ((_key: string, fallback: string) => fallback);
  const normalizedToolName = asTrimmedString(args.toolName) || "tool";
  const displayToolName = resolveToolDisplayName(normalizedToolName, translate);
  const normalizedExistingSummary = asOptionalTrimmedString(args.existingSummary);

  if (normalizedExistingSummary) {
    const shortExisting = shortenActivityTitle(normalizedExistingSummary);
    const sameAsToolName =
      shortExisting.localeCompare(normalizedToolName, undefined, {
        sensitivity: "accent",
      }) === 0;
    if (!sameAsToolName && shortExisting.length > normalizedToolName.length) {
      return shortExisting;
    }
  }

  const toolArgs = args.toolArgs ?? undefined;
  let detail: string | undefined;

  switch (normalizedToolName) {
    case "readFile":
    case "writeFile":
    case "editFile":
    case "listFiles":
      detail = asOptionalTrimmedString(toolArgs?.path) ?? ".";
      break;
    case "searchFiles":
      detail = asOptionalTrimmedString(toolArgs?.query);
      break;
    case "globFiles":
      detail =
        asOptionalTrimmedString(toolArgs?.pattern) ??
        asOptionalTrimmedString(toolArgs?.glob);
      break;
    case "execShell":
      detail =
        asOptionalTrimmedString(toolArgs?.cmd) ??
        asOptionalTrimmedString(toolArgs?.command);
      if (detail) detail = truncateWithEllipsis(detail, 80);
      break;
    case "listAgents":
    case "readAgent":
    case "callAgent":
      detail =
        asOptionalTrimmedString(toolArgs?.name) ??
        asOptionalTrimmedString(toolArgs?.agentKey);
      break;
    default:
      detail = undefined;
      break;
  }

  if (!detail) return displayToolName;
  return `${displayToolName} · ${truncateWithEllipsis(detail, 60)}`;
}

// ─── Activity line extraction & fallback ─────────────────────────────

export type ToolActivityRef =
  | { type: "file"; path: string }
  | { type: "terminal"; id?: string; label?: string }
  | { type: "url"; url: string; label?: string };

export type ToolActivityKind =
  | "read"
  | "write"
  | "edit"
  | "search"
  | "terminal"
  | "version"
  | "test"
  | "build"
  | "preview"
  | "other";

export type ToolActivityStatus = "pending" | "running" | "success" | "failed";

export type ToolActivityAction = {
  title: string;
  kind?: ToolActivityKind;
  detail?: string;
  refs?: ToolActivityRef[];
};

export type ToolActivityPhase = {
  id: string;
  title: string;
  index?: number;
  total?: number;
  status?: ToolActivityStatus;
};

export type ActivityPlanPhase = {
  id: string;
  title: string;
  index?: number;
  status?: ToolActivityStatus;
};

export type ActivityPlan = {
  title?: string;
  phases: ActivityPlanPhase[];
};

export type ToolActivity = ToolActivityAction & {
  phase?: ToolActivityPhase;
  action?: ToolActivityAction;
  plan?: ActivityPlan;
};

type ActivitySignal = {
  phase?: ToolActivityPhase;
  action?: ToolActivityAction;
  plan?: ActivityPlan;
};

export type ActivityTimelineAction = ToolActivityAction & {
  id: string;
  label: string;
  status: ToolActivityStatus;
  message: unknown;
};

export type ActivityTimelinePhase = {
  id: string;
  title: string;
  index?: number;
  total?: number;
  status: ToolActivityStatus;
  actions: ActivityTimelineAction[];
};

export type ActivityTimeline = {
  phases: ActivityTimelinePhase[];
  completedPhases: number;
  totalPhases: number;
};

export type BuildActivityTimelineOptions = {
  includePlan?: boolean;
};

const SHELL_COMMAND_CLASSIFIERS: Array<{
  pattern: RegExp;
  label: (cmd: string) => string;
}> = [
  {
    pattern: /\bgit\s+(status)\b/,
    label: () => "检查改动",
  },
  {
    pattern: /\bgit\s+diff\b/,
    label: () => "查看改动",
  },
  {
    pattern: /\bgit\s+log\b/,
    label: () => "查看历史",
  },
  {
    pattern: /\bgit\s+add\b/,
    label: () => "暂存",
  },
  {
    pattern: /\bgit\s+commit\b/,
    label: () => "提交",
  },
  {
    pattern: /\bgit\s+push\b/,
    label: () => "推送",
  },
  {
    pattern: /\bgit\s+pull\b/,
    label: () => "拉取",
  },
  {
    pattern: /\bgit\s+fetch\b/,
    label: () => "获取更新",
  },
  {
    pattern: /\bgit\s+checkout\b|\bgit\s+switch\b/,
    label: () => "切换分支",
  },
  {
    pattern: /\bgit\s+branch\b/,
    label: () => "查看分支",
  },
  {
    pattern: /\bgit\s+stash\b/,
    label: () => "贮藏",
  },
  {
    pattern: /\bgit\s+merge\b/,
    label: () => "合并",
  },
  {
    pattern: /\bgit\s+rebase\b/,
    label: () => "变基",
  },
  {
    pattern: /\bgit\s+clone\b/,
    label: () => "克隆",
  },
  {
    pattern: /\bgit\s+remote\b/,
    label: () => "远程",
  },
  {
    pattern: /\bgit\s+reset\b/,
    label: () => "重置",
  },
  {
    pattern: /\bgit\s+restore\b/,
    label: () => "还原",
  },
  {
    pattern: /\bgit\b/,
    label: () => "版本操作",
  },
  {
    pattern: /\b(rg|grep)\b/,
    label: (cmd) => {
      const match = cmd.match(/(?:rg|grep)\s+(?:-[^\s]*\s+)*['"]?([^\s'"]+)['"]?/);
      return match ? `搜索 "${match[1]}"` : "搜索代码";
    },
  },
  {
    pattern: /\b(bun\s+test|jest|vitest|mocha|pytest|go\s+test)\b/,
    label: () => "运行测试",
  },
  {
    pattern: /\b(bun\s+run\s+build|npm\s+run\s+build|yarn\s+build|make\s+build)\b/,
    label: () => "构建项目",
  },
  {
    pattern: /\b(bun\s+install|npm\s+install|yarn\s+install|pnpm\s+install)\b/,
    label: () => "安装依赖",
  },
  {
    pattern: /\b(bun\s+run\s+dev|npm\s+run\s+dev|yarn\s+dev)\b/,
    label: () => "启动开发服务器",
  },
  {
    pattern: /\bcurl\b/,
    label: (cmd) => {
      const match = cmd.match(/curl\s+(?:-[^\s]*\s+)*(https?:\/\/[^\s'"]+)/);
      return match ? `请求 ${match[1]}` : "发送 HTTP 请求";
    },
  },
  {
    pattern: /\blsof\b/,
    label: () => "查看端口占用",
  },
];

function classifyShellCommand(command: string): string {
  const trimmed = command.trim();
  for (const { pattern, label } of SHELL_COMMAND_CLASSIFIERS) {
    if (pattern.test(trimmed)) return label(trimmed);
  }
  // Prefer a short, user-facing phrase over jargon like "命令行".
  return "运行命令";
}

/**
 * Build a fallback activity line from tool call arguments when the model
 * did not provide an explicit `_activity` field.
 */
export function buildFallbackActivity(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined
): ToolActivity | undefined {
  const normalized = asTrimmedString(toolName);
  if (!normalized || !args) return undefined;

  switch (normalized) {
    case "readFile": {
      const path = asTrimmedString(args.path);
      return path ? { title: "查看相关文件", refs: [{ type: "file", path }] } : undefined;
    }
    case "writeFile": {
      const path = asTrimmedString(args.path);
      return path ? { title: "写入文件", refs: [{ type: "file", path }] } : undefined;
    }
    case "editFile": {
      const path = asTrimmedString(args.path);
      return path ? { title: "修改文件", refs: [{ type: "file", path }] } : undefined;
    }
    case "searchFiles": {
      const query = asTrimmedString(args.query);
      return query ? { title: "在代码里找线索", detail: query } : undefined;
    }
    case "globFiles": {
      const pattern = asTrimmedString(
        typeof args.pattern === "string" ? args.pattern : args.glob,
      );
      return pattern ? { title: "查找相关文件", detail: pattern } : undefined;
    }
    case "listFiles": {
      const path = asTrimmedString(args.path) || ".";
      return {
        title: "浏览目录",
        detail: path,
        refs: [{ type: "file", path }],
      };
    }
    case "execShell": {
      const command = asTrimmedString(
        typeof args.cmd === "string" ? args.cmd : args.command,
      );
      if (!command) return undefined;
      const label = classifyShellCommand(command);
      return { title: label, detail: command.length <= 120 ? command : `${command.slice(0, 117)}...` };
    }
    default:
      return undefined;
  }
}

function normalizeString(value: unknown): string | undefined {
  return asOptionalTrimmedString(value);
}

function normalizeStatus(value: unknown): ToolActivityStatus | undefined {
  return value === "pending" ||
    value === "running" ||
    value === "success" ||
    value === "failed"
    ? value
    : undefined;
}

function normalizeKind(value: unknown): ToolActivityKind | undefined {
  return value === "read" ||
    value === "write" ||
    value === "edit" ||
    value === "search" ||
    value === "terminal" ||
    value === "version" ||
    value === "test" ||
    value === "build" ||
    value === "preview" ||
    value === "other"
    ? value
    : undefined;
}

function normalizeRefs(value: unknown): ToolActivityRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.flatMap((item): ToolActivityRef[] => {
    if (!isRecord(item)) return [];
    if (item.type === "file") {
      const path = normalizeString(item.path);
      return path ? [{ type: "file", path }] : [];
    }
    if (item.type === "terminal") {
      const id = normalizeString(item.id);
      const label = normalizeString(item.label);
      return id || label ? [{ type: "terminal", ...(id ? { id } : {}), ...(label ? { label } : {}) }] : [];
    }
    if (item.type === "url") {
      const url = normalizeString(item.url);
      const label = normalizeString(item.label);
      return url ? [{ type: "url", url, ...(label ? { label } : {}) }] : [];
    }
    return [];
  });
  return refs.length ? refs : undefined;
}

function normalizeActivityAction(value: unknown): ToolActivityAction | undefined {
  if (!isRecord(value)) return undefined;
  const title = normalizeString(value.title);
  if (!title) return undefined;
  const detail = normalizeString(value.detail);
  const kind = normalizeKind(value.kind);
  const refs = normalizeRefs(value.refs);
  return {
    title: shortenActivityTitle(title),
    ...(kind ? { kind } : {}),
    ...(detail ? { detail } : {}),
    ...(refs ? { refs } : {}),
  };
}

function normalizeActivityPhase(value: unknown): ToolActivityPhase | undefined {
  if (!isRecord(value)) return undefined;
  const title = normalizeString(value.title);
  if (!title) return undefined;
  const id = normalizeString(value.id) || title.toLowerCase().replace(/\s+/g, "-");
  const index = asOptionalFiniteNumber(value.index);
  const total = asOptionalFiniteNumber(value.total);
  const status = normalizeStatus(value.status);
  return {
    id,
    title,
    ...(index !== undefined ? { index } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeActivityPlan(value: unknown): ActivityPlan | undefined {
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.phases)) return undefined;
  const phases = value.phases.flatMap((item, index): ActivityPlanPhase[] => {
    const phase = normalizeActivityPhase(item);
    if (!phase) return [];
    return [{
      id: phase.id,
      title: phase.title,
      index: phase.index ?? index + 1,
      ...(phase.status ? { status: phase.status } : {}),
    }];
  });
  if (phases.length === 0) return undefined;
  const title = normalizeString(value.title);
  return {
    ...(title ? { title } : {}),
    phases,
  };
}

function normalizeActivitySignal(value: unknown): ActivitySignal | undefined {
  if (!isRecord(value)) return undefined;
  const nestedAction = normalizeActivityAction(value.action);
  const legacyAction = normalizeActivityAction(value);
  const action = nestedAction || legacyAction;
  const phase = normalizeActivityPhase(value.phase);
  const plan = normalizeActivityPlan(value.plan);
  if (!action && !phase && !plan) return undefined;
  return {
    ...(action ? { action } : {}),
    ...(phase ? { phase } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function normalizeToolActivity(value: unknown): ToolActivity | undefined {
  const signal = normalizeActivitySignal(value);
  if (!signal?.action) return undefined;
  return {
    ...signal.action,
    ...(signal.phase ? { phase: signal.phase } : {}),
    ...(signal.action ? { action: signal.action } : {}),
    ...(signal.plan ? { plan: signal.plan } : {}),
  };
}

function formatActivityAction(activity: ToolActivityAction): string {
  const firstRef = activity.refs?.[0];
  const refLabel =
    firstRef?.type === "file"
      ? firstRef.path
      : firstRef?.type === "terminal"
        ? firstRef.label || firstRef.id
        : firstRef?.type === "url"
          ? firstRef.label || firstRef.url
          : undefined;
  const suffix = refLabel || activity.detail;
  return suffix ? `${activity.title} · ${suffix}` : activity.title;
}

function getMessageStatus(msg: any): ToolActivityStatus {
  const rawData = typeof msg?.content === "string"
    ? asOptionalJsonRecord(msg.content)
    : msg?.content;
  const isError =
    msg?.toolPayload?.status === "failed" ||
    !!msg?.toolPayload?.error ||
    !!rawData?.error;
  if (msg?.isStreaming || msg?.toolPayload?.status === "running") return "running";
  if (isError) return "failed";
  if (msg?.toolPayload?.status === "pending") return "pending";
  return "success";
}

function mergeStatuses(current: ToolActivityStatus, next: ToolActivityStatus): ToolActivityStatus {
  if (current === "running" || next === "running") return "running";
  if (current === "failed" || next === "failed") return "failed";
  if (current === "pending" || next === "pending") return "pending";
  return "success";
}

function readMessageActivity(msg: {
  toolName?: string;
  metadata?: Record<string, unknown>;
  content?: string;
  toolPayload?: Record<string, unknown>;
}): ToolActivity | undefined {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  const explicit = normalizeToolActivity(meta?.activity) ||
    normalizeToolActivity(msg.toolPayload?.activity);
  if (explicit) return explicit;
  const parsedArgs = tryParseToolArgs(msg);
  const fallback = buildFallbackActivity(msg.toolName, parsedArgs);
  return fallback ? normalizeToolActivity(fallback) : undefined;
}

function readMessageActivitySignal(msg: {
  toolName?: string;
  metadata?: Record<string, unknown>;
  content?: string;
  toolPayload?: Record<string, unknown>;
}): ActivitySignal | undefined {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  const explicit = normalizeActivitySignal(meta?.activity) ||
    normalizeActivitySignal(msg.toolPayload?.activity);
  if (explicit) return explicit;
  const parsedArgs = tryParseToolArgs(msg);
  const fallback = buildFallbackActivity(msg.toolName, parsedArgs);
  const fallbackActivity = fallback ? normalizeToolActivity(fallback) : undefined;
  return fallbackActivity
    ? {
        action: fallbackActivity.action || fallbackActivity,
        ...(fallbackActivity.phase ? { phase: fallbackActivity.phase } : {}),
        ...(fallbackActivity.plan ? { plan: fallbackActivity.plan } : {}),
      }
    : undefined;
}

function readMessageActivityPlan(msg: {
  metadata?: Record<string, unknown>;
  toolPayload?: Record<string, unknown>;
}): ActivityPlan | undefined {
  const meta = msg.metadata as Record<string, unknown> | undefined;
  const metadataActivity = isRecord(meta?.activity) ? meta.activity : undefined;
  const payloadActivity = isRecord(msg.toolPayload?.activity)
    ? msg.toolPayload.activity
    : undefined;
  return normalizeActivitySignal(metadataActivity)?.plan ||
    normalizeActivitySignal(payloadActivity)?.plan;
}

export function buildActivityTimeline(
  messages: Array<{
    id?: string;
    dbKey?: string;
    tool_call_id?: string;
    toolCallId?: string;
    toolName?: string;
    metadata?: Record<string, unknown>;
    content?: string;
    toolPayload?: Record<string, unknown>;
    isStreaming?: boolean;
  }>,
  activityPlan?: unknown,
  options: BuildActivityTimelineOptions = {}
): ActivityTimeline {
  const phases: ActivityTimelinePhase[] = [];
  const phaseById = new Map<string, ActivityTimelinePhase>();
  let implicitPhase: ActivityTimelinePhase | undefined;
  let declaredTotal = 0;
  const includePlan = options.includePlan !== false;
  const declaredPlan = includePlan
    ? normalizeActivityPlan(activityPlan) ||
      messages.map(readMessageActivityPlan).find(Boolean)
    : undefined;

  const ensurePlanPhase = (phaseDef: ActivityPlanPhase): ActivityTimelinePhase => {
    let phase = phaseById.get(phaseDef.id);
    if (!phase) {
      phase = {
        id: phaseDef.id,
        title: phaseDef.title,
        ...(phaseDef.index !== undefined ? { index: phaseDef.index } : {}),
        ...(declaredPlan ? { total: declaredPlan.phases.length } : {}),
        status: phaseDef.status || "pending",
        actions: [],
      };
      phaseById.set(phaseDef.id, phase);
      phases.push(phase);
    }
    return phase;
  };

  if (declaredPlan) {
    declaredTotal = declaredPlan.phases.length;
    for (const phaseDef of declaredPlan.phases) {
      ensurePlanPhase(phaseDef);
    }
  }

  for (const msg of messages) {
    const signal = readMessageActivitySignal(msg);
    if (!signal) continue;
    if (includePlan && !declaredPlan && signal.plan) {
      declaredTotal = Math.max(declaredTotal, signal.plan.phases.length);
      for (const phaseDef of signal.plan.phases) {
        ensurePlanPhase(phaseDef);
      }
    }

    const status = getMessageStatus(msg);
    const activityAction = signal.action;
    const phaseDef = signal.phase;
    if (!activityAction && !phaseDef) continue;
    const phaseId = phaseDef?.id || "__implicit_tools__";
    const phaseTitle = phaseDef?.title || "执行工具步骤";
    const phaseStatus = phaseDef?.status || (activityAction ? status : "pending");
    let phase = phaseById.get(phaseId);

    if (!phase) {
      phase = {
        id: phaseId,
        title: phaseTitle,
        ...(phaseDef?.index !== undefined ? { index: phaseDef.index } : {}),
        ...(phaseDef?.total !== undefined ? { total: phaseDef.total } : {}),
        status: phaseStatus,
        actions: [],
      };
      phaseById.set(phaseId, phase);
      phases.push(phase);
      if (!phaseDef) implicitPhase = phase;
    } else {
      phase.status = mergeStatuses(phase.status, phaseStatus);
      if (phase.status === "pending") {
        phase.status = phaseStatus;
      }
    }

    if (phaseDef?.total && phaseDef.total > declaredTotal) {
      declaredTotal = phaseDef.total;
    }

    if (activityAction) {
      const action: ActivityTimelineAction = {
        ...activityAction,
        id:
          normalizeString(msg.id) ||
          normalizeString(msg.dbKey) ||
          normalizeString(msg.toolCallId) ||
          normalizeString(msg.tool_call_id) ||
          `tool-action-${phase.actions.length + 1}`,
        label: formatActivityAction(activityAction),
        status,
        message: msg,
      };
      phase.actions.push(action);
    }
  }

  if (implicitPhase && phases.length > 1 && implicitPhase.actions.length === 0) {
    phaseById.delete(implicitPhase.id);
  }

  const completedPhases = phases.filter((phase) => phase.status === "success").length;
  return {
    phases,
    completedPhases,
    totalPhases: declaredTotal || phases.length,
  };
}

function tryParseToolArgs(
  msg: { content?: string; toolPayload?: Record<string, unknown>; metadata?: Record<string, unknown> }
): Record<string, unknown> | undefined {
  // 1. Standard tool payloads
  const payloadArgs = extractToolCallArgs(msg.toolPayload);
  if (payloadArgs) return payloadArgs;

  // 2. Desktop projected messages: derive from metadata fields
  const meta = msg.metadata;
  if (meta) {
    const derived: Record<string, unknown> = {};
    let hasField = false;
    const path = normalizeString(meta.path);
    if (path) {
      derived.path = path;
      hasField = true;
    }
    const command = normalizeString(meta.command);
    if (command) {
      derived.command = command;
      hasField = true;
    }
    const cmd = normalizeString(meta.cmd);
    if (cmd) {
      derived.cmd = cmd;
      hasField = true;
    }
    const query = normalizeString(meta.query);
    if (query) {
      derived.query = query;
      hasField = true;
    }
    const pattern = normalizeString(meta.pattern);
    if (pattern) {
      derived.pattern = pattern;
      hasField = true;
    }
    if (hasField) return derived;
  }

  // 3. Last resort: try parsing content as JSON tool args
  const content = normalizeString(msg.content);
  if (content) {
    try {
      const parsed = JSON.parse(content);
      if (isRecord(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON, skip
    }
  }

  return undefined;
}
