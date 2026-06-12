export function resolveToolDisplayName(
  toolName: string | undefined,
  translate: (key: string, fallback: string) => string
) {
  const normalized = typeof toolName === "string" ? toolName.trim() : "";
  if (!normalized) return translate("toolNames.tool", "Tool");
  return translate(`toolNames.${normalized}`, normalized);
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
    label: () => "用版本管理检查改动",
  },
  {
    pattern: /\bgit\s+diff\b/,
    label: () => "用版本管理查看改动",
  },
  {
    pattern: /\bgit\s+log\b/,
    label: () => "用版本管理查看历史",
  },
  {
    pattern: /\bgit\s+add\b/,
    label: () => "用版本管理暂存改动",
  },
  {
    pattern: /\bgit\s+commit\b/,
    label: () => "用版本管理保存改动",
  },
  {
    pattern: /\bgit\s+push\b/,
    label: () => "用版本管理同步改动",
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
  return "执行终端命令";
}

/**
 * Build a fallback activity line from tool call arguments when the model
 * did not provide an explicit `_activity` field.
 */
export function buildFallbackActivity(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined
): ToolActivity | undefined {
  const normalized = typeof toolName === "string" ? toolName.trim() : "";
  if (!normalized || !args) return undefined;

  switch (normalized) {
    case "readFile": {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      return path ? { title: "查看相关文件", refs: [{ type: "file", path }] } : undefined;
    }
    case "writeFile": {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      return path ? { title: "写入文件", refs: [{ type: "file", path }] } : undefined;
    }
    case "editFile": {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      return path ? { title: "修改文件", refs: [{ type: "file", path }] } : undefined;
    }
    case "searchFiles": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      return query ? { title: "在代码里找线索", detail: query } : undefined;
    }
    case "globFiles": {
      const pattern = typeof args.pattern === "string"
        ? args.pattern.trim()
        : typeof args.glob === "string"
          ? args.glob.trim()
          : "";
      return pattern ? { title: "查找相关文件", detail: pattern } : undefined;
    }
    case "execShell": {
      const command =
        typeof args.cmd === "string"
          ? args.cmd.trim()
          : typeof args.command === "string"
            ? args.command.trim()
            : "";
      if (!command) return undefined;
      const label = classifyShellCommand(command);
      return { title: label, detail: command.length <= 120 ? command : `${command.slice(0, 117)}...` };
    }
    default:
      return undefined;
  }
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
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
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    if (raw.type === "file") {
      const path = normalizeString(raw.path);
      return path ? [{ type: "file", path }] : [];
    }
    if (raw.type === "terminal") {
      const id = normalizeString(raw.id);
      const label = normalizeString(raw.label);
      return id || label ? [{ type: "terminal", ...(id ? { id } : {}), ...(label ? { label } : {}) }] : [];
    }
    if (raw.type === "url") {
      const url = normalizeString(raw.url);
      const label = normalizeString(raw.label);
      return url ? [{ type: "url", url, ...(label ? { label } : {}) }] : [];
    }
    return [];
  });
  return refs.length ? refs : undefined;
}

function normalizeActivityAction(value: unknown): ToolActivityAction | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const title = normalizeString(raw.title);
  if (!title) return undefined;
  const detail = normalizeString(raw.detail);
  const kind = normalizeKind(raw.kind);
  const refs = normalizeRefs(raw.refs);
  return {
    title,
    ...(kind ? { kind } : {}),
    ...(detail ? { detail } : {}),
    ...(refs ? { refs } : {}),
  };
}

function normalizeActivityPhase(value: unknown): ToolActivityPhase | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const title = normalizeString(raw.title);
  if (!title) return undefined;
  const id = normalizeString(raw.id) || title.toLowerCase().replace(/\s+/g, "-");
  const index = normalizeNumber(raw.index);
  const total = normalizeNumber(raw.total);
  const status = normalizeStatus(raw.status);
  return {
    id,
    title,
    ...(index !== undefined ? { index } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeActivityPlan(value: unknown): ActivityPlan | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.phases)) return undefined;
  const phases = raw.phases.flatMap((item, index): ActivityPlanPhase[] => {
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
  const title = normalizeString(raw.title);
  return {
    ...(title ? { title } : {}),
    phases,
  };
}

function normalizeActivitySignal(value: unknown): ActivitySignal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const nestedAction = normalizeActivityAction(raw.action);
  const legacyAction = normalizeActivityAction(raw);
  const action = nestedAction || legacyAction;
  const phase = normalizeActivityPhase(raw.phase);
  const plan = normalizeActivityPlan(raw.plan);
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
  const rawData = typeof msg?.content === "string" ? safeParseObject(msg.content) : msg?.content;
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
  const metadataActivity =
    meta?.activity && typeof meta.activity === "object" && !Array.isArray(meta.activity)
      ? meta.activity as Record<string, unknown>
      : undefined;
  const payloadActivity =
    msg.toolPayload?.activity &&
    typeof msg.toolPayload.activity === "object" &&
    !Array.isArray(msg.toolPayload.activity)
      ? msg.toolPayload.activity as Record<string, unknown>
      : undefined;
  return normalizeActivitySignal(metadataActivity)?.plan ||
    normalizeActivitySignal(payloadActivity)?.plan;
}

function safeParseObject(content: string): Record<string, unknown> | undefined {
  if (!content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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

/**
 * Extract activity lines from an array of tool messages for collapsed-group display.
 * Returns at most `maxLines` entries. Each entry is a displayable string.
 */
export function extractActivityLines(
  messages: Array<{
    toolName?: string;
    metadata?: Record<string, unknown>;
    content?: string;
    tool_call_id?: string;
    toolPayload?: Record<string, unknown>;
  }>,
  maxLines: number = 5
): { lines: string[]; overflow: number } {
  const lines: string[] = [];
  for (const msg of messages) {
    if (lines.length >= maxLines) break;

    // 1. Try explicit activity from metadata
    const meta = msg.metadata as Record<string, unknown> | undefined;
    const activity = normalizeToolActivity(meta?.activity) ||
      normalizeToolActivity(msg.toolPayload?.activity);

    if (activity) {
      lines.push(formatActivityAction(activity.action || activity));
      continue;
    }

    // 2. Fallback: derive from tool name + content/args
    const parsedArgs = tryParseToolArgs(msg);
    const fallback = buildFallbackActivity(msg.toolName, parsedArgs);
    if (fallback) {
      lines.push(formatActivityAction(fallback));
    }
  }
  const overflow = Math.max(0, messages.length - maxLines);
  return { lines, overflow };
}

function tryParseToolArgs(
  msg: { content?: string; toolPayload?: Record<string, unknown>; metadata?: Record<string, unknown> }
): Record<string, unknown> | undefined {
  // 1. Standard: toolPayload.input (web runtime)
  const payload = msg.toolPayload;
  if (payload && typeof payload.input === "object" && payload.input !== null) {
    return payload.input as Record<string, unknown>;
  }

  // 2. Desktop projected messages: derive from metadata fields
  const meta = msg.metadata;
  if (meta) {
    const derived: Record<string, unknown> = {};
    let hasField = false;
    if (typeof meta.path === "string" && meta.path.trim()) {
      derived.path = meta.path.trim();
      hasField = true;
    }
    if (typeof meta.command === "string" && meta.command.trim()) {
      derived.command = meta.command.trim();
      hasField = true;
    }
    if (typeof meta.cmd === "string" && meta.cmd.trim()) {
      derived.cmd = meta.cmd.trim();
      hasField = true;
    }
    if (typeof meta.query === "string" && meta.query.trim()) {
      derived.query = meta.query.trim();
      hasField = true;
    }
    if (typeof meta.pattern === "string" && meta.pattern.trim()) {
      derived.pattern = meta.pattern.trim();
      hasField = true;
    }
    if (hasField) return derived;
  }

  // 3. Last resort: try parsing content as JSON tool args
  if (typeof msg.content === "string" && msg.content.trim()) {
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not JSON, skip
    }
  }

  return undefined;
}
