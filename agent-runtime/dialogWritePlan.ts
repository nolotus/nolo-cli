import { asOptionalTrimmedString } from "../core/optionalString";
import { asRecordOrEmpty } from "../core/recordOrEmpty";
import type {
  AgentRuntimeChatMessage,
  AgentRuntimeHost,
} from "./types";
import type { AgentRuntimeSaveTurnInput } from "./hostAdapter";
import { dialogMessageKey } from "../database/keys";

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
  if (typeof args.existingDialog?.title === "string" && args.existingDialog.title.trim()) {
    return args.existingDialog.title;
  }
  const lastUserText = extractLastUserText(args.messages).trim();
  return lastUserText ? lastUserText.slice(0, 80) : "Local agent run";
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
      return {
        type: "put" as const,
        key,
        value: {
          id,
          dbKey: key,
          dialogId: args.dialogId,
          role: message.role,
          content: message.content ?? "",
          ...(message.role === "user" ? { userId: args.userId } : {}),
          ...(message.role === "assistant" ? {
            agentKey: args.input.agentKey,
            cybotKey: args.input.agentKey,
          } : {}),
          ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
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
}): { dialogId: string; ops: DialogWriteOp[] } {
  const dialogId = args.input.continueDialogId || args.createId();
  const nowIso = new Date(args.now).toISOString();
  const dialogKey = `dialog-${args.userId}-${dialogId}`;
  const subjectRefs = buildRuntimeSubjectRefs(args.input.runtimeContext);
  const dialogRecord = {
    ...asRecordOrEmpty(args.existingDialog),
    id: dialogId,
    dbKey: dialogKey,
    type: "dialog",
    userId: args.userId,
    cybots: [args.input.agentKey],
    primaryAgentKey: args.input.agentKey,
    title: resolveDialogTitle({
      existingDialog: args.existingDialog,
      messages: args.input.messages,
    }),
    status: "done",
    triggerType: `${args.runtimeHost}-local`,
    executionMode: "foreground",
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
