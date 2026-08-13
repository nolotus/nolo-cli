import { asOptionalTrimmedString } from "../core/optionalString";
import { asRecordOrEmpty } from "../core/recordOrEmpty";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeHost,
} from "./types";
import type { AgentRuntimeSaveTurnInput } from "./hostAdapter";
import { dialogMessageKey } from "../database/keys";
import { buildDialogFallbackTitleFromUserInput } from "../chat/dialog/dialogTitle";

type DialogRecord = Record<string, any>;
type DialogWriteOp = {
  type: "put";
  key: string;
  value: DialogRecord;
};
type DialogSubjectRef = {
  kind: string;
  id: string;
  role?: string;
};

function extractLastUserText(messages: AgentRuntimeChatMessage[]) {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (typeof lastUser?.content === "string") return lastUser.content;
  if (Array.isArray(lastUser?.content)) {
    return lastUser.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(" ");
  }
  return "";
}

function resolveDialogTitle(args: {
  existingDialog?: DialogRecord | null;
  messages: AgentRuntimeChatMessage[];
}) {
  const existing = args.existingDialog?.title;
  if (typeof existing === "string" && existing.trim()) {
    return existing.trim();
  }
  const lastUserText = extractLastUserText(args.messages).trim();
  return buildDialogFallbackTitleFromUserInput(lastUserText) || "Local agent run";
}

/**
 * Final dialog title for a write plan, by priority:
 *   1. caller-supplied titleOverride (e.g. LLM-generated / periodic update)
 *      — UNLESS the existing title is manual (titleSource:"manual"), which is
 *      never overwritten by a generated override.
 *   2. existing dialog title (if not being overridden)
 *   3. resolveDialogTitle fallback (last user message / "Local agent run")
 * Named pickDialogTitle to avoid a name clash with the fallback-only
 * resolveDialogTitle above.
 *
 * MEDIUM-1: titleSource "manual" protects a user-set title from being
 * overwritten by LLM-generated overrides. Returns the chosen title plus the
 * titleSource that should be persisted alongside it.
 */
function pickDialogTitle(args: {
  existingDialog?: DialogRecord | null;
  titleOverride?: string;
  messages: AgentRuntimeChatMessage[];
}): { title: string; titleSource: "generated" | "manual" } {
  const existingSource = args.existingDialog?.titleSource;
  const existingIsManual = existingSource === "manual";
  const override = args.titleOverride?.trim();
  if (override && !existingIsManual) {
    return { title: override, titleSource: "generated" };
  }
  const existing = args.existingDialog?.title;
  if (typeof existing === "string" && existing.trim()) {
    // Preserve an existing manual source; otherwise default to "generated"
    // (existing non-manual titles were produced by the generation pipeline).
    return {
      title: existing.trim(),
      titleSource: existingIsManual ? "manual" : "generated",
    };
  }
  // No existing title: a generated override still wins over the fallback.
  if (override) {
    return { title: override, titleSource: "generated" };
  }
  return {
    title: resolveDialogTitle({
      existingDialog: args.existingDialog,
      messages: args.messages,
    }),
    titleSource: "generated",
  };
}

function normalizeSubjectRef(ref: unknown): DialogSubjectRef | null {
  if (!ref || typeof ref !== "object") return null;
  const raw = ref as Record<string, unknown>;
  const kind = asOptionalTrimmedString(raw.kind);
  const id = asOptionalTrimmedString(raw.id);
  if (!kind || !id) return null;
  const role = asOptionalTrimmedString(raw.role);
  return {
    kind,
    id,
    ...(role ? { role } : {}),
  };
}

/**
 * MEDIUM-1: parse the titleUpdatedAt timestamp (ms epoch) from an existing
 * dialog record. Accepts either a number or an ISO string. Returns 0 when
 * absent or unparseable — callers treat 0 as "never generated" and apply the
 * conservative throttle rule (don't regenerate when a non-empty title exists).
 */
function parseTitleUpdatedAtMs(existingDialog?: DialogRecord | null): number {
  const raw = existingDialog?.titleUpdatedAt;
  if (typeof raw === "number" && !Number.isNaN(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function mergeSubjectRefs(...groups: unknown[]): DialogSubjectRef[] | undefined {
  const refs: DialogSubjectRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const item of group) {
      const ref = normalizeSubjectRef(item);
      if (!ref) continue;
      const key = `${ref.kind}:${ref.id}:${ref.role ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs.length ? refs : undefined;
}

function buildRuntimeSubjectRefs(runtimeContext?: Record<string, any> | null): DialogSubjectRef[] | undefined {
  return mergeSubjectRefs(runtimeContext?.subjectRefs);
}

function buildDialogLineageFields(args: {
  input: AgentRuntimeSaveTurnInput;
  existingDialog?: DialogRecord | null;
}) {
  const inheritedFromDialogKey = asOptionalTrimmedString(args.input.inheritedFromDialogKey);
  const parentDialogId = asOptionalTrimmedString(args.input.parentDialogId);
  if (!inheritedFromDialogKey && !parentDialogId) return {};
  const rootDialogId =
    asOptionalTrimmedString(args.existingDialog?.rootDialogId) ??
    asOptionalTrimmedString(args.existingDialog?.parentDialogId) ??
    parentDialogId;
  return {
    ...(inheritedFromDialogKey ? { inheritedFromDialogKey } : {}),
    ...(parentDialogId ? { parentDialogId } : {}),
    ...(rootDialogId ? { rootDialogId } : {}),
  };
}

function buildDialogMessageWriteOps(args: {
  dialogId: string;
  input: AgentRuntimeSaveTurnInput;
  userId: string;
  now: number;
  nowIso: string;
}): DialogWriteOp[] {
  return args.input.messages
    .filter((message) => message.role !== "system")
    .map((message, index) => {
      // Keep timestamp-prefix ordering for LevelDB range scans. Do not switch
      // to opaque ids until dialog query/continuation callers are reviewed.
      const id = `${args.now}-${String(index + 1).padStart(3, "0")}`;
      const key = dialogMessageKey(args.dialogId, id);
      // 工具名是 tool 行的语义字段：桌面端折叠头、CLI toolsUsed 统计都读它。
      // 缺它时 UI 只能兜底成「工具」，故在落库层强制持久化。
      const toolName = asOptionalTrimmedString(message.toolName);
      return {
        type: "put" as const,
        key,
        value: {
          id,
          dbKey: key,
          dialogId: args.dialogId,
          role: message.role,
          content: message.content ?? "",
          ...(message.context_reference !== undefined
            ? { contextReference: message.context_reference }
            : {}),
          // 持久化思维链(reasoning):空轮/异常排查的关键证据,
          // 回读由 dialogMessageRecordToAgentRuntimeMessage 还原。
          ...(typeof message.reasoning_content === "string"
            ? { reasoning_content: message.reasoning_content }
            : {}),
          ...(message.role === "user" ? { userId: args.userId } : {}),
          ...(message.role === "assistant" ? {
            agentKey: args.input.agentKey,
            cybotKey: args.input.agentKey,
          } : {}),
          ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
          ...(toolName ? { toolName } : {}),
          ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}),
          ...(message.tool_result_metadata ? { metadata: message.tool_result_metadata } : {}),
          createdAt: args.nowIso,
        },
      };
    });
}

export function buildAgentRuntimeDialogWritePlan(args: {
  input: AgentRuntimeSaveTurnInput;
  userId: string;
  now: number;
  createId: () => string;
  runtimeHost: AgentRuntimeHost;
  runtimeMetadata?: Record<string, unknown>;
  existingDialog?: DialogRecord | null;
  /**
   * Pre-computed dialog title (e.g. from an async LLM title generator).
   * When provided, takes precedence over existingDialog.title and fallback titles.
   */
  titleOverride?: string;
}): { dialogId: string; title: string; ops: DialogWriteOp[] } {
  const dialogId = args.input.continueDialogId || args.createId();
  const nowIso = new Date(args.now).toISOString();
  const dialogKey = `dialog-${args.userId}-${dialogId}`;
  const subjectRefs = buildRuntimeSubjectRefs(args.input.runtimeContext);
  const requestedAgentMode =
    args.input.runtimeContext?.dialogAgentMode === "auto" ||
    args.input.runtimeContext?.dialogAgentMode === "fixed"
      ? args.input.runtimeContext.dialogAgentMode
      : undefined;
  const agentMode =
    requestedAgentMode ??
    (args.existingDialog?.agentMode === "auto" ? "auto" : "fixed");
  const dialogAgentFields =
    agentMode === "auto"
      ? {
          agentMode: "auto" as const,
          cybots: [] as string[],
          primaryAgentKey: undefined,
        }
      : {
          agentMode: "fixed" as const,
          cybots: [args.input.agentKey],
          primaryAgentKey: args.input.agentKey,
        };
  const pickedTitle = pickDialogTitle({
    existingDialog: args.existingDialog,
    titleOverride: args.titleOverride,
    messages: args.input.messages,
  });
  const existingTitleUpdatedAtMs = parseTitleUpdatedAtMs(args.existingDialog);
  // titleUpdatedAt tracks the last time the title content was actually
  // (re)generated or manually set — distinct from updatedAt (any field
  // change). Used by writeDialog's throttle. When the title changes this
  // turn (override applied, or first-time generation), refresh it to now.
  const titleChanged =
    typeof args.titleOverride === "string" && args.titleOverride.trim().length > 0;
  const titleUpdatedAtIso = titleChanged
    ? nowIso
    : existingTitleUpdatedAtMs > 0
      ? new Date(existingTitleUpdatedAtMs).toISOString()
      : (args.existingDialog?.createdAt ?? nowIso);
  const dialogRecord = {
    ...asRecordOrEmpty(args.existingDialog),
    id: dialogId,
    dbKey: dialogKey,
    type: "dialog",
    userId: args.userId,
    ...dialogAgentFields,
    title: pickedTitle.title,
    titleSource: pickedTitle.titleSource,
    titleUpdatedAt: titleUpdatedAtIso,
    status: args.input.result.error === true ? "failed" : "done",
    triggerType: `${args.runtimeHost}-local`,
    executionMode: args.existingDialog?.executionMode ?? "foreground",
    createdAt: args.existingDialog?.createdAt ?? nowIso,
    updatedAt: nowIso,
    finishedAt: args.now,
    usage: args.input.result.usage,
    ...(asOptionalTrimmedString(args.input.spaceId)
      ? { spaceId: asOptionalTrimmedString(args.input.spaceId) }
      : {}),
    ...(asOptionalTrimmedString(args.input.category)
      ? { category: asOptionalTrimmedString(args.input.category) }
      : {}),
    ...(subjectRefs ? { subjectRefs } : {}),
    ...buildDialogLineageFields({
      input: args.input,
      existingDialog: args.existingDialog,
    }),
    ...(typeof args.input.result.toolCallCount === "number"
      ? { toolCallCount: args.input.result.toolCallCount }
      : {}),
    localRuntime: {
      host: args.runtimeHost,
      ...(args.runtimeMetadata ?? {}),
    },
    ...(args.input.result.runtimeToolSurface
      ? {
          runtimeCheckpoint: {
            ...asRecordOrEmpty(args.existingDialog?.runtimeCheckpoint),
            toolSurface: args.input.result.runtimeToolSurface,
          },
        }
      : {}),
  };
  return {
    dialogId,
    title: dialogRecord.title,
    ops: [
      {
        type: "put",
        key: dialogKey,
        value: dialogRecord,
      },
      ...buildDialogMessageWriteOps({
        dialogId,
        input: args.input,
        userId: args.userId,
        now: args.now,
        nowIso,
      }),
    ],
  };
}
