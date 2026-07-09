import { selectRuntimeSnapshot } from "../../app/stateViews/runtime";
import { DataType } from "../../create/types";
import { createSpaceKey } from "../../create/space/spaceKeys";
import { redactAgentRecordForWorkspaceTool } from "../../agent-runtime/runtimeToolSurface";
import {
  clampNoloPositiveInteger,
  buildNoloSubjectRefQueryTarget,
  filterNoloDialogSubjectRefEvidence,
  getNoloComparableUpdatedAt,
  getNoloDialogIdFromKey,
  NOLO_WORKSPACE_TOOL_NAMES,
  normalizeNoloExcludeDialogIds,
  normalizeNoloSpaceInput,
  resolveNoloDialogInput,
  verifyNoloDialogSubjectRefQuery,
} from "../../agent-runtime/noloWorkspaceTools";
import {
  buildDeleteDialogsPreview,
  filterDialogDeletionCandidates,
  resolveConfirmedDialogDeletionTargets,
  type DeleteDialogsMatchMode,
} from "./deleteDialogsToolModel";

type ToolResult = {
  rawData: unknown;
  displayData?: string;
};

const jsonPreview = (value: unknown, maxLength = 1800) => {
  const text = JSON.stringify(value, null, 2);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...(truncated)`;
};

const normalizeServer = (value: unknown) =>
  typeof value === "string" && value.trim()
    ? value.trim().replace(/\/+$/, "")
    : "";

const getRuntime = (thunkApi: any) => {
  const state = thunkApi?.getState?.();
  return state ? selectRuntimeSnapshot(state) : null;
};

const authHeaders = (token?: string) =>
  token ? { Authorization: `Bearer ${token}` } : {};

async function readRemoteRecord(args: {
  serverBase?: string;
  token?: string;
  dbKey: string;
  includeDeleted?: boolean;
}) {
  const serverBase = normalizeServer(args.serverBase);
  if (!serverBase || !args.token) return null;
  const query = args.includeDeleted ? "?includeDeleted=true" : "";
  const response = await fetch(
    `${serverBase}/api/v1/db/read/${encodeURIComponent(args.dbKey)}${query}`,
    { headers: authHeaders(args.token) } as RequestInit
  );
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  return payload?.data ?? payload;
}

async function queryRemoteUserRecords(args: {
  serverBase?: string;
  token?: string;
  userId?: string;
  type: string | string[];
  limit: number;
  subjectRef?: object;
}) {
  const serverBase = normalizeServer(args.serverBase);
  if (!serverBase || !args.token || !args.userId) return [];
  const response = await fetch(
    `${serverBase}/api/v1/db/query/${encodeURIComponent(args.userId)}?limit=${args.limit}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(args.token),
      },
      body: JSON.stringify({
        type: args.type,
        ...(args.subjectRef ? { subjectRef: args.subjectRef } : {}),
      }),
    } as RequestInit
  );
  if (!response.ok) return [];
  const payload = await response.json().catch(() => null);
  return Array.isArray(payload?.data?.data)
    ? payload.data.data
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
}

async function queryBestRecords(
  thunkApi: any,
  type: string | string[],
  limit: number
) {
  const runtime = getRuntime(thunkApi);
  const remoteRecords = await queryRemoteUserRecords({
    serverBase: runtime?.currentServer,
    token: runtime?.currentToken,
    userId: runtime?.currentUserId,
    type,
    limit,
  }).catch(() => []);
  return remoteRecords;
}

async function readBestRecord(thunkApi: any, dbKey: string, includeDeleted = false) {
  const runtime = getRuntime(thunkApi);
  return readRemoteRecord({
    serverBase: runtime?.currentServer,
    token: runtime?.currentToken,
    dbKey,
    includeDeleted,
  }).catch(() => null);
}

export const listDialogsFunctionSchema = {
  name: "listDialogs",
  description: "List the current user's Nolo dialogs. Use before readDialog when the target dialog is unclear.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Maximum dialogs to return. Default 100, max 500." },
      space: { type: "string", description: "Optional space id or URL." },
      includeScheduled: { type: "boolean", description: "Include scheduled/background run dialogs." },
    },
  },
} as const;

export async function listDialogsFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const limit = clampNoloPositiveInteger(args?.limit, 100, 500);
  const includeScheduled = args?.includeScheduled === true;
  const records = await queryBestRecords(thunkApi, DataType.DIALOG, limit * 3);
  const dialogs = records
    .filter((record: any) =>
      includeScheduled
        ? true
        : record?.triggerType !== "scheduled_run" &&
          record?.triggerType !== "automation_run" &&
          !record?.parentTaskKey &&
          !record?.parentAutomationKey
    )
    .sort((left: any, right: any) => getNoloComparableUpdatedAt(right) - getNoloComparableUpdatedAt(left))
    .slice(0, limit)
    .map((record: any) => ({
      id: typeof record?.id === "string" ? record.id : getNoloDialogIdFromKey(String(record?.dbKey ?? "")),
      dbKey: record?.dbKey ?? null,
      title: record?.title ?? record?.taskLabel ?? "(untitled)",
      status: record?.status ?? null,
      updatedAt: record?.updatedAt ?? record?.updated_at ?? null,
      createdAt: record?.createdAt ?? record?.created ?? null,
      spaceId: record?.spaceId ?? null,
      triggerType: record?.triggerType ?? null,
      primaryAgentKey: record?.primaryAgentKey ?? null,
    }));
  return {
    rawData: { success: true, total: dialogs.length, dialogs },
    displayData: jsonPreview({ total: dialogs.length, dialogs }),
  };
}

export const readDialogFunctionSchema = {
  name: "readDialog",
  description: "Read one persisted Nolo dialog, including metadata and recent messages.",
  parameters: {
    type: "object",
    properties: {
      dialog: { type: "string", description: "Dialog id, dialog dbKey, or dialog URL." },
      limit: { type: "integer", description: "Message limit. Default 120, max 1000." },
    },
    required: ["dialog"],
  },
} as const;

export const queryDialogsBySubjectRefFunctionSchema = {
  name: "queryDialogsBySubjectRef",
  description:
    "Query persisted Nolo dialog evidence by generic dialog.subjectRefs. Read-only; use readDialog for full message traces.",
  parameters: {
    type: "object",
    properties: {
      rowDbKey: { type: "string", description: "Convenience target for a table-row task subject ref." },
      subjectKind: { type: "string", description: "Generic subject ref kind, such as table-row, page, file, commit, or artifact." },
      subjectId: { type: "string", description: "Generic subject ref id." },
      subjectRole: { type: "string", description: "Optional subject ref role." },
      limit: { type: "integer", description: "Maximum matching dialog summaries to return. Default 20, max 100." },
      status: { type: "string", description: "Optional dialog status filter." },
      checkpointStatus: { type: "string", description: "Optional runtimeCheckpoint.status filter." },
      hasArtifacts: { type: "boolean", description: "When true, only return dialogs with artifacts." },
      excludeDialogId: { type: "string", description: "Optional dialog id or dbKey to exclude from evidence results, typically the current caller dialog." },
    },
  },
} as const;

export const deleteDialogsFunctionSchema = {
  name: "deleteDialogs",
  description: [
    "Find and delete the current user's Nolo dialogs by title, id, or dbKey.",
    "Dangerous operation: first preview matching dialogs and wait for user confirmation, then delete.",
    "Only dialogs owned by the current user are deletable. The current running dialog is skipped by default.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Dialog title/id/dbKey search text, for example 中医评测 or a dialog id.",
      },
      matchMode: {
        type: "string",
        enum: ["contains", "exact", "prefix", "dialogId"],
        description:
          "Matching mode. contains=title/id/dbKey contains query, exact=exact title/id/dbKey, prefix=title/id prefix, dialogId=exact dialog id/dbKey. Default contains.",
        default: "contains",
      },
      confirmedDialogIds: {
        type: "array",
        items: { type: "string" },
        description:
          "Dialog IDs or dbKeys supplied by the UI confirmation step. The tool will not delete anything unless these IDs are present.",
      },
    },
    required: ["query"],
  },
} as const;

export async function queryDialogsBySubjectRefFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const runtime = getRuntime(thunkApi);
  const target = buildNoloSubjectRefQueryTarget(args ?? {});
  if (!target) throw new Error("queryDialogsBySubjectRef requires rowDbKey or subjectKind plus subjectId.");
  const queryLimit = clampNoloPositiveInteger(args?.queryLimit, 500, 500);
  const outputLimit = clampNoloPositiveInteger(args?.limit, 20, 100);
  const dialogs = await queryRemoteUserRecords({
    serverBase: runtime?.currentServer,
    token: runtime?.currentToken,
    userId: runtime?.currentUserId,
    type: DataType.DIALOG,
    limit: queryLimit,
    subjectRef: target,
  });
  const status = typeof args?.status === "string" && args.status.trim() ? args.status.trim() : null;
  const checkpointStatus =
    typeof args?.checkpointStatus === "string" && args.checkpointStatus.trim()
      ? args.checkpointStatus.trim()
      : null;
  const hasArtifacts = typeof args?.hasArtifacts === "boolean" ? args.hasArtifacts : null;
  const excludeDialogIds = normalizeNoloExcludeDialogIds([
    args?.excludeDialogId,
    args?.excludeDialog,
    ...(Array.isArray(args?.excludeDialogIds) ? args.excludeDialogIds : []),
  ]);
  const result = {
    success: true,
    source: "db.query.subjectRef",
    readOnly: true,
    target,
    ...(excludeDialogIds.length ? { excludedDialogIds: excludeDialogIds } : {}),
    strict: verifyNoloDialogSubjectRefQuery(dialogs, target, { excludeDialogIds }),
    total: 0,
    dialogs: filterNoloDialogSubjectRefEvidence({
      dialogs,
      target,
      limit: outputLimit,
      status,
      checkpointStatus,
      hasArtifacts,
      excludeDialogIds,
    }),
  };
  result.total = result.dialogs.length;
  return {
    rawData: result,
    displayData: jsonPreview(result),
  };
}

export async function readDialogFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const runtime = getRuntime(thunkApi);
  const userId = runtime?.currentUserId;
  if (!userId) throw new Error("readDialog requires a signed-in user.");
  const rawDialog = typeof args?.dialog === "string"
    ? args.dialog.trim()
    : typeof args?.dialogId === "string"
      ? args.dialogId.trim()
      : typeof args?.id === "string"
        ? args.id.trim()
        : "";
  if (!rawDialog) throw new Error("readDialog requires dialog.");
  const resolved = resolveNoloDialogInput(rawDialog, userId);
  const limit = clampNoloPositiveInteger(args?.limit, 120, 1000);
  const meta = await readBestRecord(thunkApi, resolved.dbKey, true);

  let messages: any[] = [];
  const serverBase = normalizeServer(runtime?.currentServer);
  if (serverBase && runtime?.currentToken) {
    const response = await fetch(`${serverBase}/rpc/getConvMsgs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(runtime.currentToken),
      },
      body: JSON.stringify({ dialogId: resolved.dialogId, limit }),
    } as RequestInit).catch(() => null);
    if (response?.ok) {
      const payload = await response.json().catch(() => []);
      messages = Array.isArray(payload) ? payload : [];
    }
  }

  return {
    rawData: {
      success: true,
      dialogKey: resolved.dbKey,
      dialogId: resolved.dialogId,
      meta,
      messages,
    },
    displayData: jsonPreview({
      dialogKey: resolved.dbKey,
      title: meta?.title,
      messageCount: messages.length,
      messages,
    }),
  };
}

const formatDeleteDialogsPreview = (preview: ReturnType<typeof buildDeleteDialogsPreview>) => {
  if (preview.deletable.length === 0 && preview.skipped.length === 0) {
    return "没有找到匹配的对话。";
  }
  const lines = [
    `找到 ${preview.deletable.length} 个可删除对话，${preview.skipped.length} 个跳过。`,
    "",
  ];
  if (preview.deletable.length > 0) {
    lines.push("是否删除这些对话？");
    for (const item of preview.deletable) {
      lines.push(`- ${item.title} (${item.dialogId})`);
    }
    lines.push("");
    lines.push("需要确认后才会删除。");
  }
  if (preview.skipped.length > 0) {
    lines.push("跳过：");
    for (const item of preview.skipped) {
      lines.push(`- ${item.title || item.dialogId || item.dbKey}：${item.reason}`);
    }
  }
  return lines.join("\n");
};

const loadDeleteDialogsPreview = async (args: any, thunkApi: any) => {
  const runtime = getRuntime(thunkApi);
  const userId = runtime?.currentUserId;
  if (!userId) throw new Error("deleteDialogs requires a signed-in user.");
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("deleteDialogs requires query.");
  const records = await queryRemoteUserRecords({
    serverBase: runtime?.currentServer,
    token: runtime?.currentToken,
    userId,
    type: DataType.DIALOG,
    limit: 500,
  });
  const candidates = filterDialogDeletionCandidates(records, {
    query,
    matchMode: args?.matchMode as DeleteDialogsMatchMode | undefined,
  });
  const currentDialogId =
    typeof args?.currentDialogId === "string" && args.currentDialogId.trim()
      ? args.currentDialogId.trim()
      : (() => {
          const currentDialogKey = thunkApi?.getState?.()?.dialog?.currentDialogKey;
          return typeof currentDialogKey === "string"
            ? getNoloDialogIdFromKey(currentDialogKey)
            : null;
        })();
  return buildDeleteDialogsPreview({
    currentUserId: userId,
    candidates,
    currentDialogId,
  });
};

export async function deleteDialogsPreviewFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const preview = await loadDeleteDialogsPreview(args, thunkApi);
  return {
    rawData: {
      requiresConfirmation: true,
      ...preview,
    },
    displayData: formatDeleteDialogsPreview(preview),
  };
}

export async function deleteDialogsFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const preview = await loadDeleteDialogsPreview(args, thunkApi);
  const confirmedIds =
    Array.isArray(args?.confirmedDialogIds) && args.confirmedDialogIds.length > 0
      ? args.confirmedDialogIds
      : [];
  if (confirmedIds.length === 0) {
    throw new Error("deleteDialogs requires confirmedDialogIds from the preview confirmation UI.");
  }
  const { targets, missingConfirmedDialogIds } =
    resolveConfirmedDialogDeletionTargets(preview, confirmedIds);
  const deletedDialogIds: string[] = [];
  const deletedDialogKeys: string[] = [];
  const failures: Array<{ dbKey: string; detail: string }> = [];
  const { deleteDialog } = await import("../../chat/dialog/dialogSlice");

  for (const target of targets) {
    try {
      await thunkApi.dispatch(deleteDialog(target.dbKey)).unwrap();
    } catch (error: any) {
      failures.push({
        dbKey: target.dbKey,
        detail: error?.message || String(error),
      });
      continue;
    }
    deletedDialogIds.push(target.dialogId);
    deletedDialogKeys.push(target.dbKey);
  }

  return {
    rawData: {
      deletedDialogIds,
      deletedDialogKeys,
      missingConfirmedDialogIds,
      skipped: preview.skipped,
      failures,
    },
    displayData:
      deletedDialogIds.length > 0
        ? `已删除 ${deletedDialogIds.length} 个对话：${deletedDialogIds.join(", ")}。`
        : "没有删除任何对话。",
  };
}

export const listAgentsFunctionSchema = {
  name: "listAgents",
  description: "List the current user's Nolo agents.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Maximum agents to return. Default 100, max 500." },
      publicOnly: { type: "boolean", description: "Only show public agents." },
    },
  },
} as const;

export async function listAgentsFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const limit = clampNoloPositiveInteger(args?.limit, 100, 500);
  const records = await queryBestRecords(thunkApi, DataType.AGENT, limit);
  const agents = records
    .sort((left: any, right: any) => getNoloComparableUpdatedAt(right) - getNoloComparableUpdatedAt(left))
    .map((record: any) => ({
      id: record?.id ?? null,
      privateKey: record?.dbKey ?? null,
      publicKey: typeof record?.id === "string" ? `agent-pub-${record.id}` : null,
      name: record?.name ?? "(unnamed)",
      model: record?.model ?? null,
      provider: record?.provider ?? record?.apiSource ?? null,
      isPublic: record?.isPublic === true,
      updatedAt: record?.updatedAt ?? record?.createdAt ?? null,
      tools: Array.isArray(record?.tools) ? record.tools : [],
    }))
    .filter((agent: any) => args?.publicOnly !== true || agent.isPublic);
  return {
    rawData: { success: true, total: agents.length, agents },
    displayData: jsonPreview({ total: agents.length, agents }),
  };
}

export const readAgentFunctionSchema = {
  name: "readAgent",
  description: "Read one Nolo agent config.",
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", description: "Agent key, id, alias, or URL." },
    },
    required: ["agent"],
  },
} as const;

export async function readAgentFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const runtime = getRuntime(thunkApi);
  const userId = runtime?.currentUserId;
  if (!userId) throw new Error("readAgent requires a signed-in user.");
  const rawAgent = typeof args?.agent === "string"
    ? args.agent.trim()
    : typeof args?.agentKey === "string"
      ? args.agentKey.trim()
      : typeof args?.id === "string"
        ? args.id.trim()
        : "";
  if (!rawAgent) throw new Error("readAgent requires agent.");
  const raw = rawAgent.startsWith("http://") || rawAgent.startsWith("https://")
    ? new URL(rawAgent).pathname.split("/").filter(Boolean).at(-1) ?? rawAgent
    : rawAgent;
  const candidates = raw.startsWith("agent-")
    ? [raw]
    : [`agent-${userId}-${raw}`, `agent-pub-${raw}`];
  for (const candidate of candidates) {
    const record = await readBestRecord(thunkApi, candidate, true);
    if (record) {
      return {
        rawData: {
          success: true,
          agentKey: candidate,
          record: redactAgentRecordForWorkspaceTool(record),
        },
        displayData: jsonPreview({
          agentKey: candidate,
          record: redactAgentRecordForWorkspaceTool(record),
        }),
      };
    }
  }
  throw new Error(`readAgent not found: ${rawAgent}`);
}

export const listSpacesFunctionSchema = {
  name: "listSpaces",
  description: "List joined Nolo spaces.",
  parameters: {
    type: "object",
    properties: {},
  },
} as const;

export async function listSpacesFunc(_args: any, thunkApi: any): Promise<ToolResult> {
  const runtime = getRuntime(thunkApi);
  const serverBase = normalizeServer(runtime?.currentServer);
  if (serverBase && runtime?.currentToken && runtime?.currentUserId) {
    const response = await fetch(`${serverBase}/rpc/getUserSpaceMemberships`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(runtime.currentToken),
      },
      body: JSON.stringify({ userId: runtime.currentUserId }),
    } as RequestInit).catch(() => null);
    if (response?.ok) {
      const memberships = await response.json().catch(() => []);
      if (Array.isArray(memberships)) {
        const spaces = memberships.map((membership: any) => ({
          spaceId: membership?.spaceId ?? null,
          spaceKey: membership?.spaceId ? createSpaceKey.space(String(membership.spaceId)) : null,
          name: membership?.spaceName ?? membership?.name ?? membership?.spaceId ?? null,
          role: membership?.role ?? null,
          ownerId: membership?.ownerId ?? null,
          visibility: membership?.visibility ?? null,
        }));
        return {
          rawData: { success: true, total: spaces.length, spaces },
          displayData: jsonPreview({ total: spaces.length, spaces }),
        };
      }
    }
  }
  throw new Error("listSpaces requires a signed-in user and reachable Nolo server.");
}

export const readSpaceFunctionSchema = {
  name: "readSpace",
  description: "Read one Nolo space and optionally list its contents.",
  parameters: {
    type: "object",
    properties: {
      space: { type: "string", description: "Space id or URL." },
      contentKey: { type: "string", description: "Optional content key inside the space." },
      brief: { type: "boolean", description: "Return brief content entries." },
    },
    required: ["space"],
  },
} as const;

export async function readSpaceFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const rawSpace = typeof args?.space === "string"
    ? args.space.trim()
    : typeof args?.spaceId === "string"
      ? args.spaceId.trim()
      : typeof args?.id === "string"
        ? args.id.trim()
        : "";
  if (!rawSpace) throw new Error("readSpace requires space.");
  const spaceId = normalizeNoloSpaceInput(rawSpace);
  const spaceKey = createSpaceKey.space(spaceId);
  const space = await readBestRecord(thunkApi, spaceKey, true);
  if (!space) throw new Error(`readSpace not found: ${rawSpace}`);
  const contentKeyFilter = typeof args?.contentKey === "string" ? args.contentKey.trim() : "";
  const allContents = Object.entries(space?.contents ?? {})
    .filter(([, value]) => value && typeof value === "object")
    .map(([entryKey, value]) => ({ entryKey, ...(value as Record<string, any>) }));
  const contents = contentKeyFilter
    ? allContents.filter((item: any) => {
        const contentKey = typeof item.contentKey === "string" && item.contentKey.trim()
          ? item.contentKey.trim()
          : item.entryKey;
        return item.entryKey === contentKeyFilter || contentKey === contentKeyFilter;
      })
    : allContents;
  const result = {
    success: true,
    spaceId,
    spaceKey,
    name: space?.name ?? null,
    description: space?.description ?? null,
    ownerId: space?.ownerId ?? null,
    visibility: space?.visibility ?? null,
    contentCount: allContents.length,
    contents: args?.brief === true
      ? contents.map((item: any) => ({
          entryKey: item.entryKey,
          contentKey: item.contentKey ?? item.entryKey,
          type: item.type ?? null,
          title: item.title ?? null,
          categoryId: item.categoryId ?? null,
        }))
      : contents,
    ...(contentKeyFilter ? { contentKeyFilter, matchedCount: contents.length } : {}),
  };
  return {
    rawData: result,
    displayData: jsonPreview(result),
  };
}

export const readSkillDocFunctionSchema = {
  name: "readSkillDoc",
  description: "Read one Nolo skill doc/page by page dbKey.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Skill doc page dbKey, for example page-xxx." },
      doc: { type: "string", description: "Alias for id." },
    },
    required: ["id"],
  },
} as const;

export async function readSkillDocFunc(args: any, thunkApi: any): Promise<ToolResult> {
  const { buildReadDocResult } = await import("./readDocTool");
  const id = args?.id ?? args?.doc ?? args?.docKey ?? args?.pageKey;
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("readSkillDoc requires id or doc.");
  }
  const page = await readBestRecord(thunkApi, id.trim(), true);
  if (!page) throw new Error(`readSkillDoc not found: ${id}`);
  const result = buildReadDocResult(page);
  return { rawData: result.rawData, displayData: result.displayData };
}

export const cliWhoamiFunctionSchema = {
  name: "cliWhoami",
  description: "Show the current Nolo runtime identity. In Web/RN this reports browser runtime identity.",
  parameters: { type: "object", properties: {} },
} as const;

export async function cliWhoamiFunc(_args: any, thunkApi: any): Promise<ToolResult> {
  const runtime = getRuntime(thunkApi);
  const result = {
    success: true,
    runtime: "browser",
    serverBase: runtime?.currentServer ?? null,
    userId: runtime?.currentUserId ?? null,
    authenticated: !!runtime?.currentToken,
  };
  return { rawData: result, displayData: jsonPreview(result) };
}

export const cliDoctorFunctionSchema = {
  name: "cliDoctor",
  description: "Show Nolo runtime diagnostics. In Web/RN this reports browser tool diagnostics.",
  parameters: { type: "object", properties: {} },
} as const;

export async function cliDoctorFunc(_args: any, thunkApi: any): Promise<ToolResult> {
  const runtime = getRuntime(thunkApi);
  const result = {
    success: true,
    runtime: "browser",
    serverBase: runtime?.currentServer ?? null,
    authenticated: !!runtime?.currentToken,
    userId: runtime?.currentUserId ?? null,
    diagnosticScope: "nolo_workspace_subset",
    message:
      "workspaceTools is a subset for Nolo workspace inspection, not necessarily the complete current run tool surface.",
    noloWorkspaceToolSubset: [...NOLO_WORKSPACE_TOOL_NAMES],
    workspaceTools: [...NOLO_WORKSPACE_TOOL_NAMES],
    workspaceToolsAreSubset: true,
  };
  return { rawData: result, displayData: jsonPreview(result) };
}
